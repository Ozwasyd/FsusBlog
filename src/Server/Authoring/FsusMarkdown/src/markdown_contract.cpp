#include "markdown_contract.hpp"
#include "markdown_latex.hpp"
#include "markdown_mermaid.hpp"

#include <algorithm>
#include <unordered_map>
#include <unordered_set>
#include <cctype>
#include <string>
#include <string_view>
#include <vector>

namespace fsusblog::wasm::markdown {
namespace {

constexpr std::string_view kCodeClass = "shiki";

using table_alignment = syntax_table_alignment;

struct footnote_def {
  std::string label;
  std::string content;
};

struct reference_def {
  std::string label;
  std::string url;
};

std::string render_inline(
  std::string_view text,
  const render_request& request,
  std::vector<std::string>& footnote_refs,
  const std::vector<reference_def>& reference_defs
);
std::string render_blockquote(
  const std::vector<std::string_view>& lines,
  std::size_t& index,
  const render_request& request,
  std::vector<std::string>& footnote_refs,
  std::vector<footnote_def>& footnote_defs,
  std::vector<reference_def>& reference_defs,
  const std::vector<std::size_t>& line_columns
);
std::string render_document_v2(
  std::string_view source,
  const render_request& request,
  std::vector<std::string>& footnote_refs,
  std::vector<footnote_def>& footnote_defs,
  std::vector<reference_def>& reference_defs,
  bool is_top_level,
  const std::vector<std::size_t>* column_origins = nullptr,
  const std::vector<std::string_view>* inherited_line_anchors = nullptr
);

std::size_t count_lines(std::string_view text) {
  if (text.empty()) {
    return 0;
  }

  std::size_t lines = 1;
  for (char ch : text) {
    if (ch == '\n') {
      ++lines;
    }
  }

  return lines;
}

std::size_t find_token_column(std::string_view line, std::string_view token) {
  const std::size_t index = line.find(token);
  return index == std::string_view::npos ? 0 : index + 1;
}

placeholder make_placeholder(
  placeholder_kind kind,
  std::string token,
  std::string label,
  std::string source,
  std::size_t line,
  std::size_t column,
  std::size_t end_line,
  std::size_t end_column,
  std::size_t start_offset,
  std::size_t end_offset
) {
  placeholder result;
  result.kind = kind;
  result.token = std::move(token);
  result.label = std::move(label);
  result.source = std::move(source);
  result.line = line;
  result.column = column;
  result.end_line = end_line;
  result.end_column = end_column;
  result.start_offset = start_offset;
  result.end_offset = end_offset;
  return result;
}

bool is_space(char ch) {
  return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\f' || ch == '\v';
}

bool is_digit(char ch) {
  return ch >= '0' && ch <= '9';
}

std::string_view trim_left(std::string_view input) {
  std::size_t index = 0;
  while (index < input.size() && is_space(input[index])) {
    ++index;
  }
  return input.substr(index);
}

std::string_view trim_right(std::string_view input) {
  std::size_t index = input.size();
  while (index > 0 && is_space(input[index - 1])) {
    --index;
  }
  return input.substr(0, index);
}

std::string_view trim(std::string_view input) {
  return trim_right(trim_left(input));
}

void append_literal(std::string& out, std::string_view value) {
  out.append(value.data(), value.size());
}

void append_escaped(std::string& out, std::string_view value) {
  append_literal(out, escape_html(value));
}

std::string to_lower_ascii(std::string_view input) {
  std::string output;
  output.reserve(input.size());
  for (char ch : input) {
    output.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
  }
  return output;
}

std::string normalize_reference_label(std::string_view input) {
  std::string label;
  label.reserve(input.size());
  bool previous_space = false;
  for (char ch : trim(input)) {
    if (is_space(ch)) {
      if (!previous_space && !label.empty()) {
        label.push_back(' ');
      }
      previous_space = true;
      continue;
    }
    label.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
    previous_space = false;
  }
  return label;
}

bool is_safe_url(std::string_view input) {
  const std::string_view url = trim(input);
  if (url.empty()) {
    return false;
  }

  for (const unsigned char ch : url) {
    if (ch <= 0x20 || ch == 0x7f || ch == '\\') {
      return false;
    }
  }

  if (url.starts_with("//")) {
    return false;
  }

  if (url.front() == '/' || url.front() == '#' || url.starts_with("./") || url.starts_with("../")) {
    return true;
  }

  const auto colon = url.find(':');
  if (colon == std::string_view::npos) {
    return true;
  }

  const std::string scheme = to_lower_ascii(url.substr(0, colon));
  return scheme == "http" || scheme == "https" || scheme == "mailto" || scheme == "tel";
}

std::string resolve_url(std::string_view base_url, std::string_view input) {
  const std::string_view url = trim(input);
  if (!is_safe_url(url)) {
    return "#";
  }

  const auto colon = url.find(':');
  if (url.front() == '/' || url.front() == '#' || url.starts_with("./") || url.starts_with("../") || colon != std::string_view::npos) {
    return escape_html(url);
  }

  const std::string_view base = trim(base_url);
  if (base.empty() || !is_safe_url(base)) {
    return escape_html(url);
  }

  std::string resolved;
  resolved.reserve(base.size() + url.size() + 1);
  resolved.append(base.data(), base.size());
  if (!resolved.empty() && resolved.back() != '/') {
    resolved.push_back('/');
  }
  resolved.append(url.data(), url.size());
  return escape_html(resolved);
}

const reference_def* find_reference(
  const std::vector<reference_def>& reference_defs,
  std::string_view label
) {
  const std::string normalized = normalize_reference_label(label);
  if (normalized.empty()) {
    return nullptr;
  }

  for (const auto& def : reference_defs) {
    if (def.label == normalized) {
      return &def;
    }
  }

  return nullptr;
}

bool is_word_char(char ch) {
  return std::isalnum(static_cast<unsigned char>(ch)) != 0;
}

std::size_t count_repeated(std::string_view text, std::size_t index, char delimiter) {
  std::size_t count = 0;
  while (index + count < text.size() && text[index + count] == delimiter) {
    ++count;
  }
  return count;
}

bool can_open_emphasis(std::string_view text, std::size_t index, char delimiter, std::size_t run_length) {
  if (index + run_length >= text.size()) {
    return false;
  }

  const char next = text[index + run_length];
  if (is_space(next)) {
    return false;
  }

  if (delimiter == '_' && index > 0 && is_word_char(text[index - 1]) && is_word_char(next)) {
    return false;
  }

  return true;
}

bool can_close_emphasis(std::string_view text, std::size_t index, char delimiter, std::size_t run_length) {
  if (index == 0) {
    return false;
  }

  const char previous = text[index - 1];
  if (is_space(previous)) {
    return false;
  }

  if (delimiter == '_'
    && index + run_length < text.size()
    && is_word_char(previous)
    && is_word_char(text[index + run_length])) {
    return false;
  }

  return true;
}

std::size_t choose_emphasis_length(std::size_t run_length) {
  return std::min<std::size_t>(run_length, 3);
}

std::size_t scan_emphasis_close(
  std::string_view text,
  std::size_t start_index,
  char delimiter,
  std::size_t delimiter_length
) {
  std::size_t index = start_index;
  while (index < text.size()) {
    if (text[index] == '\\' && index + 1 < text.size()) {
      index += 2;
      continue;
    }

    if (text[index] == '`') {
      const std::size_t close = text.find('`', index + 1);
      if (close == std::string_view::npos) {
        break;
      }

      index = close + 1;
      continue;
    }

    if (text[index] == delimiter) {
      const std::size_t close_run = count_repeated(text, index, delimiter);
      if (close_run >= delimiter_length && can_close_emphasis(text, index, delimiter, delimiter_length)) {
        return index;
      }

      index += close_run;
      continue;
    }

    ++index;
  }

  return std::string_view::npos;
}

bool try_render_emphasis_v2(
  std::string_view text,
  std::size_t index,
  const render_request& request,
  std::vector<std::string>& footnote_refs,
  const std::vector<reference_def>& reference_defs,
  std::string& out,
  std::size_t& next_index
) {
  const char delimiter = text[index];
  if (delimiter != '*' && delimiter != '_') {
    return false;
  }

  const std::size_t open_run = count_repeated(text, index, delimiter);
  if (open_run == 0) {
    return false;
  }

  for (std::size_t delimiter_length = choose_emphasis_length(open_run); delimiter_length > 0; --delimiter_length) {
    if (open_run < delimiter_length || !can_open_emphasis(text, index, delimiter, delimiter_length)) {
      if (delimiter_length == 1) {
        break;
      }
      continue;
    }

    const std::size_t close_index = scan_emphasis_close(text, index + delimiter_length, delimiter, delimiter_length);
    if (close_index == std::string_view::npos || close_index <= index + delimiter_length) {
      if (delimiter_length == 1) {
        break;
      }
      continue;
    }

    const std::string_view inner = text.substr(index + delimiter_length, close_index - index - delimiter_length);
    if (inner.empty()) {
      if (delimiter_length == 1) {
        break;
      }
      continue;
    }

    const std::string rendered_inner = render_inline(inner, request, footnote_refs, reference_defs);
    switch (delimiter_length) {
      case 3:
        out.append("<strong><em>");
        out.append(rendered_inner);
        out.append("</em></strong>");
        break;
      case 2:
        out.append("<strong>");
        out.append(rendered_inner);
        out.append("</strong>");
        break;
      case 1:
        out.append("<em>");
        out.append(rendered_inner);
        out.append("</em>");
        break;
      default:
        return false;
    }

    next_index = close_index + delimiter_length;
    return true;
  }

  return false;
}

std::string escape_and_wrap_code(std::string_view code, std::string_view language = {}) {
  std::string out;
  out.reserve(code.size() + 64);
  out.append("<pre class=\"");
  out.append(kCodeClass);
  out.append("\"><code");
  if (!language.empty()) {
    out.append(" class=\"language-");
    out.append(escape_html(language));
    out.append("\"");
  }
  out.append(">");
  out.append(escape_html(code));
  out.append("</code></pre>");
  return out;
}

std::string render_image(std::string_view alt, std::string_view url, std::string_view base_url) {
  std::string out;
  out.reserve(alt.size() + url.size() + 96);
  out.append("<img loading=\"lazy\" decoding=\"async\" referrerpolicy=\"no-referrer\" src=\"");
  out.append(resolve_url(base_url, url));
  out.append("\" alt=\"");
  out.append(escape_html(alt));
  out.append("\" />");
  return out;
}

std::string render_link(std::string_view label, std::string_view url, std::string_view base_url) {
  std::string out;
  out.reserve(label.size() + url.size() + 96);
  out.append("<a href=\"");
  out.append(resolve_url(base_url, url));
  out.append("\" rel=\"noopener noreferrer\" target=\"_blank\">");
  out.append(escape_html(label));
  out.append("</a>");
  return out;
}

std::string render_link_html(std::string_view label_html, std::string_view url, std::string_view base_url) {
  std::string out;
  out.reserve(label_html.size() + url.size() + 96);
  out.append("<a href=\"");
  out.append(resolve_url(base_url, url));
  out.append("\" rel=\"noopener noreferrer\" target=\"_blank\">");
  out.append(label_html.data(), label_html.size());
  out.append("</a>");
  return out;
}

bool try_render_code_span(
  std::string_view text,
  std::size_t index,
  std::string& out,
  std::size_t& next_index
) {
  if (text[index] != '`') {
    return false;
  }

  const std::size_t run_length = count_repeated(text, index, '`');
  if (run_length == 0) {
    return false;
  }

  std::size_t cursor = index + run_length;
  while (cursor < text.size()) {
    const std::size_t close = text.find('`', cursor);
    if (close == std::string_view::npos) {
      return false;
    }
    const std::size_t close_run = count_repeated(text, close, '`');
    if (close_run == run_length) {
      std::string code(text.substr(index + run_length, close - index - run_length));
      std::replace(code.begin(), code.end(), '\n', ' ');
      if (code.size() >= 2 && code.front() == ' ' && code.back() == ' ') {
        const bool has_non_space = std::any_of(code.begin(), code.end(), [](char ch) { return ch != ' '; });
        if (has_non_space) {
          code.erase(code.begin());
          code.pop_back();
        }
      }
      out.append("<code>");
      out.append(escape_html(code));
      out.append("</code>");
      next_index = close + run_length;
      return true;
    }
    cursor = close + close_run;
  }

  return false;
}

bool contains_code_span(std::string_view text) {
  std::size_t index = 0;
  while (index < text.size()) {
    const std::size_t code_index = text.find('`', index);
    if (code_index == std::string_view::npos) {
      return false;
    }

    std::string ignored;
    std::size_t next_index = code_index + 1;
    if (try_render_code_span(text, code_index, ignored, next_index)) {
      return true;
    }

    index = code_index + 1;
  }

  return false;
}

std::string inline_flow_class_attr(std::string_view text, std::string_view base_class, std::string_view code_class) {
  std::string attr;
  attr.reserve(base_class.size() + code_class.size() + 12);
  attr.append(" class=\"");
  attr.append(base_class.data(), base_class.size());
  if (contains_code_span(text)) {
    attr.push_back(' ');
    attr.append(code_class.data(), code_class.size());
  }
  attr.push_back('"');
  return attr;
}

std::string render_inline(
  std::string_view text,
  const render_request& request,
  std::vector<std::string>& footnote_refs,
  const std::vector<reference_def>& reference_defs
) {
  std::string out;
  out.reserve(text.size() + 64);

  std::size_t index = 0;
  std::size_t segment_start = 0;

  auto flush_segment = [&](std::size_t end) {
    if (end > segment_start) {
      append_escaped(out, text.substr(segment_start, end - segment_start));
    }
  };

  while (index < text.size()) {
    const char ch = text[index];

    if (request.allow_latex && ch == '\\' && index + 1 < text.size() && (text[index + 1] == '(' || text[index + 1] == '[')) {
      const char terminator = text[index + 1] == '(' ? ')' : ']';
      const std::string_view needle = terminator == ')' ? std::string_view{"\\)"} : std::string_view{"\\]"};
      const std::size_t close = text.find(needle, index + 2);
      if (close != std::string_view::npos) {
        flush_segment(index);
        const std::string_view math = text.substr(index + 2, close - index - 2);
        out.append(latex::render_fragment({
          math,
          latex::fragment_kind::inline_math
        }));
        index = close + 2;
        segment_start = index;
        continue;
      }
    }

    if (ch == '\\' && index + 1 < text.size()) {
      if (!request.allow_latex && (text[index + 1] == '(' || text[index + 1] == ')' || text[index + 1] == '[' || text[index + 1] == ']')) {
        ++index;
        continue;
      }
      flush_segment(index);
      append_escaped(out, text.substr(index + 1, 1));
      index += 2;
      segment_start = index;
      continue;
    }

    if (ch == '`') {
      std::string code_html;
      std::size_t next_index = index;
      if (try_render_code_span(text, index, code_html, next_index)) {
        flush_segment(index);
        out.append(code_html);
        index = next_index;
        segment_start = index;
        continue;
      }
    }

    if (ch == '~' && index + 1 < text.size() && text[index + 1] == '~') {
      const std::size_t close = text.find("~~", index + 2);
      if (close != std::string_view::npos && close > index + 2) {
        flush_segment(index);
        out.append("<del>");
        out.append(render_inline(text.substr(index + 2, close - index - 2), request, footnote_refs, reference_defs));
        out.append("</del>");
        index = close + 2;
        segment_start = index;
        continue;
      }
    }

    if (ch == '<') {
      const std::size_t close = text.find('>', index + 1);
      if (close != std::string_view::npos) {
        const std::string_view target = text.substr(index + 1, close - index - 1);
        const std::string lower = to_lower_ascii(target);
        const bool is_autolink = lower.starts_with("http://")
          || lower.starts_with("https://")
          || lower.starts_with("mailto:");
        const bool is_email = target.find('@') != std::string_view::npos
          && target.find(' ') == std::string_view::npos
          && target.find(':') == std::string_view::npos;
        if (is_autolink || is_email) {
          flush_segment(index);
          const std::string href = is_email ? "mailto:" + std::string(target) : std::string(target);
          out.append(render_link(target, href, request.base_url));
          index = close + 1;
          segment_start = index;
          continue;
        }
      }
    }

    // Footnote reference [^label]
    if (ch == '[' && index + 1 < text.size() && text[index + 1] == '^') {
      const std::size_t label_end = text.find(']', index + 2);
      if (label_end != std::string_view::npos) {
        const std::string_view label = text.substr(index + 2, label_end - index - 2);
        if (!label.empty()) {
          flush_segment(index);

          int fn_index = -1;
          for (std::size_t i = 0; i < footnote_refs.size(); ++i) {
            if (footnote_refs[i] == label) {
              fn_index = static_cast<int>(i + 1);
              break;
            }
          }
          if (fn_index == -1) {
            footnote_refs.emplace_back(label);
            fn_index = static_cast<int>(footnote_refs.size());
          }

          out.append("<sup><a href=\"#fn-");
          out.append(escape_html(label));
          out.append("\" id=\"fnref-");
          out.append(escape_html(label));
          out.append("\" class=\"footnote-ref\">");
          out.append(std::to_string(fn_index));
          out.append("</a></sup>");

          index = label_end + 1;
          segment_start = index;
          continue;
        }
      }
    }

    if (ch == '!' && index + 1 < text.size() && text[index + 1] == '[') {
      const std::size_t label_end = text.find(']', index + 2);
      if (label_end != std::string_view::npos && label_end + 1 < text.size() && text[label_end + 1] == '(') {
        const std::size_t url_end = text.find(')', label_end + 2);
        if (url_end != std::string_view::npos) {
          flush_segment(index);
          out.append(render_image(text.substr(index + 2, label_end - index - 2), text.substr(label_end + 2, url_end - label_end - 2), request.base_url));
          index = url_end + 1;
          segment_start = index;
          continue;
        }
      }
      if (label_end != std::string_view::npos && label_end + 1 < text.size() && text[label_end + 1] == '[') {
        const std::size_t ref_end = text.find(']', label_end + 2);
        if (ref_end != std::string_view::npos) {
          const std::string_view alt = text.substr(index + 2, label_end - index - 2);
          std::string_view ref_label = text.substr(label_end + 2, ref_end - label_end - 2);
          if (ref_label.empty()) {
            ref_label = alt;
          }
          if (const reference_def* def = find_reference(reference_defs, ref_label)) {
            flush_segment(index);
            out.append(render_image(alt, def->url, request.base_url));
            index = ref_end + 1;
            segment_start = index;
            continue;
          }
        }
      }
    }

    if (ch == '[') {
      const std::size_t label_end = text.find(']', index + 1);
      if (label_end != std::string_view::npos && label_end + 1 < text.size() && text[label_end + 1] == '(') {
        const std::size_t url_end = text.find(')', label_end + 2);
        if (url_end != std::string_view::npos) {
          flush_segment(index);
          out.append(render_link(text.substr(index + 1, label_end - index - 1), text.substr(label_end + 2, url_end - label_end - 2), request.base_url));
          index = url_end + 1;
          segment_start = index;
          continue;
        }
      }
      if (label_end != std::string_view::npos && label_end + 1 < text.size() && text[label_end + 1] == '[') {
        const std::size_t ref_end = text.find(']', label_end + 2);
        if (ref_end != std::string_view::npos) {
          const std::string_view label = text.substr(index + 1, label_end - index - 1);
          std::string_view ref_label = text.substr(label_end + 2, ref_end - label_end - 2);
          if (ref_label.empty()) {
            ref_label = label;
          }
          if (const reference_def* def = find_reference(reference_defs, ref_label)) {
            flush_segment(index);
            const std::string label_html = render_inline(label, request, footnote_refs, reference_defs);
            out.append(render_link_html(label_html, def->url, request.base_url));
            index = ref_end + 1;
            segment_start = index;
            continue;
          }
        }
      }
    }

    if (ch == '*' || ch == '_') {
      std::string emphasis_html;
      std::size_t next_index = index;
      if (try_render_emphasis_v2(text, index, request, footnote_refs, reference_defs, emphasis_html, next_index)) {
        flush_segment(index);
        out.append(emphasis_html);
        index = next_index;
        segment_start = index;
        continue;
      }
    }

    ++index;
  }

  flush_segment(index);

  return out;
}

std::string render_heading(
  std::string_view line,
  const render_request& request,
  std::vector<std::string>& footnote_refs,
  const std::vector<reference_def>& reference_defs,
  std::string_view anchor_id = {}
) {
  const std::string_view trimmed = trim_left(line);
  std::size_t level = 0;
  while (level < trimmed.size() && trimmed[level] == '#') {
    ++level;
  }
  if (level == 0 || level > 6 || (level < trimmed.size() && trimmed[level] != ' ')) {
    return {};
  }

  std::string_view content = trim(trimmed.substr(std::min(level + 1, trimmed.size())));
  while (content.size() > 1 && content.back() == '#') {
    content = trim_right(content.substr(0, content.size() - 1));
  }
  std::string out;
  out.reserve(content.size() + anchor_id.size() + 40);
  out.append("<h");
  out.push_back(static_cast<char>('0' + level));
  if (!anchor_id.empty()) {
    out.append(" id=\"");
    out.append(anchor_id);
    out.push_back('"');
  }
  out.append(">");
  out.append(render_inline(content, request, footnote_refs, reference_defs));
  out.append("</h");
  out.push_back(static_cast<char>('0' + level));
  out.append(">");
  return out;
}

bool parse_unordered_list_item(std::string_view line, std::string_view& content) {
  const std::string_view trimmed = trim_left(line);
  if (trimmed.size() < 2) {
    return false;
  }

  const char marker = trimmed[0];
  if ((marker != '-' && marker != '*' && marker != '+') || trimmed[1] != ' ') {
    return false;
  }

  content = trim_left(trimmed.substr(2));
  return true;
}

bool parse_ordered_list_item(std::string_view line, std::string_view& content) {
  const std::string_view trimmed = trim_left(line);
  if (trimmed.empty()) {
    return false;
  }

  std::size_t index = 0;
  while (index < trimmed.size() && is_digit(trimmed[index])) {
    ++index;
  }

  if (index == 0 || index + 1 >= trimmed.size()) {
    return false;
  }

  if ((trimmed[index] != '.' && trimmed[index] != ')') || trimmed[index + 1] != ' ') {
    return false;
  }

  content = trim_left(trimmed.substr(index + 2));
  return true;
}

bool is_horizontal_rule(std::string_view line) {
  const std::string_view trimmed = trim(line);
  if (trimmed.size() < 3) {
    return false;
  }

  const char marker = trimmed.front();
  if (marker != '-' && marker != '*' && marker != '_') {
    return false;
  }

  for (char ch : trimmed) {
    if (ch != marker) {
      return false;
    }
  }

  return true;
}

int parse_setext_heading_level(std::string_view line) {
  const std::string_view trimmed = trim(line);
  if (trimmed.empty()) {
    return 0;
  }

  const char marker = trimmed.front();
  if (marker != '=' && marker != '-') {
    return 0;
  }

  for (char ch : trimmed) {
    if (ch != marker) {
      return 0;
    }
  }

  return marker == '=' ? 1 : 2;
}

bool is_indented_code_line(std::string_view line, std::size_t column = 0) {
  const std::size_t start_column = column;
  for (char ch : line) {
    if (ch == ' ') {
      ++column;
    } else if (ch == '\t') {
      column += 4 - column % 4;
    } else {
      break;
    }
    if (column - start_column >= 4) {
      return true;
    }
  }
  return false;
}

std::string strip_code_indent(std::string_view line, std::size_t column = 0) {
  std::size_t index = 0;
  const std::size_t target_column = column + 4;
  while (index < line.size() && column < target_column) {
    if (line[index] == ' ') {
      ++column;
      ++index;
    } else if (line[index] == '\t') {
      column += 4 - column % 4;
      ++index;
    } else {
      break;
    }
  }
  return std::string(column > target_column ? column - target_column : 0, ' ') +
    std::string(line.substr(index));
}

bool parse_fence_start(std::string_view line, char& fence_char, std::string_view& language) {
  const std::string_view trimmed = trim_left(line);
  if (trimmed.size() < 3) {
    return false;
  }

  const char marker = trimmed.front();
  if (marker != '`' && marker != '~') {
    return false;
  }

  std::size_t count = 0;
  while (count < trimmed.size() && trimmed[count] == marker) {
    ++count;
  }

  if (count < 3) {
    return false;
  }

  fence_char = marker;
  language = trim_left(trimmed.substr(count));
  return true;
}

bool parse_fence_end(std::string_view line, char fence_char) {
  const std::string_view trimmed = trim_left(line);
  if (trimmed.size() < 3 || trimmed.front() != fence_char) {
    return false;
  }

  std::size_t count = 0;
  while (count < trimmed.size() && trimmed[count] == fence_char) {
    ++count;
  }

  return count >= 3;
}

bool is_paragraph_group_start(std::string_view line) {
  return trim(line) == "::p";
}

bool is_paragraph_group_end(std::string_view line) {
  return trim(line) == "::";
}

bool continues_nested_list(std::string_view line) {
  const auto indentation = line.size() - trim_left(line).size();
  std::string_view content;
  return indentation >= 2 &&
    (parse_unordered_list_item(line, content) || parse_ordered_list_item(line, content));
}

bool parse_task_list_marker(std::string_view item, bool& checked, std::string_view& content) {
  const std::string_view trimmed = trim_left(item);
  if (trimmed.size() < 4 || trimmed.front() != '[' || trimmed[2] != ']' || trimmed[3] != ' ') {
    return false;
  }

  const char marker = static_cast<char>(std::tolower(static_cast<unsigned char>(trimmed[1])));
  if (marker != 'x' && marker != ' ') {
    return false;
  }

  checked = marker == 'x';
  content = trim_left(trimmed.substr(4));
  return true;
}

std::string render_list(
  const std::vector<std::string>& items,
  bool ordered,
  const render_request& request,
  std::vector<std::string>& footnote_refs,
  std::vector<footnote_def>& footnote_defs,
  std::vector<reference_def>& reference_defs,
  const std::vector<std::string_view>* item_anchors = nullptr,
  const std::vector<std::vector<std::string_view>>* child_line_anchors = nullptr
) {
  if (items.empty()) {
    return {};
  }

  std::string out;
  out.reserve(128 + items.size() * 64);
  out.append(ordered ? "<ol>" : "<ul>");
  for (std::size_t item_index = 0; item_index < items.size(); ++item_index) {
    const auto& item = items[item_index];
    bool checked = false;
    std::string_view task_content;
    const bool is_task = !ordered && parse_task_list_marker(item, checked, task_content);
    const std::string_view item_content = is_task ? task_content : std::string_view(item);
    out.append("<li");
    if (item_anchors && item_index < item_anchors->size() && !(*item_anchors)[item_index].empty()) {
      out.append(" id=\"");
      out.append((*item_anchors)[item_index]);
      out.push_back('"');
    }
    out.append(inline_flow_class_attr(
      item_content,
      "markdown-renderer__list-item",
      "markdown-renderer__list-item--inline-code"
    ));
    out.push_back('>');
    if (is_task) {
      out.append("<input type=\"checkbox\" disabled");
      if (checked) {
        out.append(" checked");
      }
      out.append(" /> ");
    }

    if (item_content.find('\n') != std::string_view::npos) {
      const auto* child_anchors =
        child_line_anchors && item_index < child_line_anchors->size()
          ? &(*child_line_anchors)[item_index] : nullptr;
      out.append(render_document_v2(
        item_content, request, footnote_refs, footnote_defs, reference_defs,
        false, nullptr, child_anchors
      ));
    } else {
      out.append(render_inline(item_content, request, footnote_refs, reference_defs));
    }
    out.append("</li>");
  }
  out.append(ordered ? "</ol>" : "</ul>");
  return out;
}

std::vector<std::string_view> split_lines(std::string_view source) {
  std::vector<std::string_view> lines;
  lines.reserve(32);

  std::size_t line_start = 0;
  while (line_start <= source.size()) {
    const std::size_t line_end = source.find('\n', line_start);
    const std::string_view line = line_end == std::string_view::npos
      ? source.substr(line_start)
      : source.substr(line_start, line_end - line_start);
    lines.push_back(line);

    if (line_end == std::string_view::npos) {
      break;
    }

    line_start = line_end + 1;
  }

  return lines;
}

struct blockquote_line final {
  std::string source;
  std::size_t column{0};
};

blockquote_line strip_blockquote_prefix(std::string_view line, std::size_t column) {
  const std::string_view trimmed = trim_left(line);
  if (trimmed.empty() || trimmed.front() != '>') {
    return {};
  }

  const std::size_t marker = line.size() - trimmed.size();
  for (std::size_t cursor = 0; cursor <= marker; ++cursor) {
    column += line[cursor] == '\t' ? 4 - column % 4 : 1;
  }
  std::size_t index = marker + 1;
  if (index < line.size() && line[index] == '\t') {
    const std::size_t remainder = 4 - column % 4 - 1;
    return {std::string(remainder, ' ') + std::string(line.substr(index + 1)), column + 1};
  }
  if (index < line.size() && line[index] == ' ') {
    ++index;
    ++column;
  }

  return {std::string(line.substr(index)), column};
}

struct table_cell_source_range final {
  std::size_t start{0};
  std::size_t end{0};
};

std::vector<table_cell_source_range> table_cell_source_ranges(
  std::string_view row,
  std::vector<std::size_t>* delimiters = nullptr
) {
  std::vector<table_cell_source_range> ranges;
  const std::size_t begin = row.starts_with('|') ? 1 : 0;
  std::size_t cell_start = begin;
  bool escaped = false;
  std::size_t backtick_run = 0;
  bool trailing_delimiter = false;

  const auto append_range = [&](std::size_t start, std::size_t end) {
    while (start < end && is_space(row[start])) {
      ++start;
    }
    while (end > start && is_space(row[end - 1])) {
      --end;
    }
    ranges.push_back({start, end});
  };

  for (std::size_t index = begin; index < row.size(); ++index) {
    const char ch = row[index];
    if (escaped) {
      escaped = false;
      trailing_delimiter = false;
      continue;
    }
    if (ch == '\\') {
      escaped = true;
      trailing_delimiter = false;
      continue;
    }
    if (ch == '`') {
      std::size_t run = 1;
      while (index + run < row.size() && row[index + run] == '`') {
        ++run;
      }
      if (backtick_run == 0) {
        bool has_closing_run = false;
        for (std::size_t search = index + run; search < row.size();) {
          if (row[search] != '`') {
            ++search;
            continue;
          }
          std::size_t closing_run = 1;
          while (
            search + closing_run < row.size() &&
            row[search + closing_run] == '`'
          ) {
            ++closing_run;
          }
          if (closing_run == run) {
            has_closing_run = true;
            break;
          }
          search += closing_run;
        }
        if (has_closing_run) {
          backtick_run = run;
        }
      } else if (backtick_run == run) {
        backtick_run = 0;
      }
      index += run - 1;
      trailing_delimiter = false;
      continue;
    }
    if (ch == '|' && backtick_run == 0) {
      if (delimiters != nullptr) {
        delimiters->push_back(index);
      }
      append_range(cell_start, index);
      cell_start = index + 1;
      trailing_delimiter = cell_start == row.size();
      continue;
    }
    trailing_delimiter = false;
  }

  if (!trailing_delimiter) {
    append_range(cell_start, row.size());
  }
  return ranges;
}

std::vector<std::string> split_table_cells(std::string_view row) {
  std::vector<std::string> cells;
  for (const auto& range : table_cell_source_ranges(row)) {
    std::string cell;
    const std::string_view source = row.substr(
      range.start,
      range.end - range.start
    );
    bool escaped = false;
    for (const char ch : source) {
      if (escaped) {
        cell.push_back(ch);
        escaped = false;
      } else if (ch == '\\') {
        escaped = true;
      } else {
        cell.push_back(ch);
      }
    }
    if (escaped) {
      cell.push_back('\\');
    }
    cells.emplace_back(std::move(cell));
  }
  return cells;
}

bool parse_table_separator_cell(std::string_view cell, table_alignment& alignment) {
  const std::string_view trimmed = trim(cell);
  if (trimmed.empty()) {
    return false;
  }

  std::size_t index = 0;
  const bool left = trimmed.starts_with(':');
  const bool right = trimmed.ends_with(':');

  if (left) {
    ++index;
  }

  std::size_t hyphen_count = 0;
  while (index < trimmed.size() && trimmed[index] == '-') {
    ++index;
    ++hyphen_count;
  }

  if (hyphen_count < 1) {
    return false;
  }

  if (right) {
    if (index != trimmed.size() - 1) {
      return false;
    }
  } else if (index != trimmed.size()) {
    return false;
  }

  if (left && right) {
    alignment = table_alignment::center;
  } else if (left) {
    alignment = table_alignment::left;
  } else if (right) {
    alignment = table_alignment::right;
  } else {
    alignment = table_alignment::none;
  }

  return true;
}

bool parse_table_separator_row(std::string_view row, std::vector<table_alignment>& alignments) {
  const std::vector<std::string> cells = split_table_cells(row);
  if (cells.empty()) {
    return false;
  }

  alignments.clear();
  alignments.reserve(cells.size());
  for (const auto& cell : cells) {
    table_alignment alignment = table_alignment::none;
    if (!parse_table_separator_cell(cell, alignment)) {
      return false;
    }
    alignments.push_back(alignment);
  }

  return true;
}

std::size_t find_next_non_empty_line(const std::vector<std::string_view>& lines, std::size_t start) {
  std::size_t cursor = start;
  while (cursor < lines.size()) {
    if (!trim(lines[cursor]).empty()) {
      return cursor;
    }
    ++cursor;
  }

  return std::string_view::npos;
}

std::string table_alignment_attribute(table_alignment alignment) {
  switch (alignment) {
    case table_alignment::left:
      return " style=\"text-align:left\"";
    case table_alignment::center:
      return " style=\"text-align:center\"";
    case table_alignment::right:
      return " style=\"text-align:right\"";
    case table_alignment::none:
      return {};
  }

  return {};
}

std::string render_table_row(
  const std::vector<std::string>& cells,
  bool header,
  const std::vector<table_alignment>& alignments,
  const render_request& request,
  std::vector<std::string>& footnote_refs,
  const std::vector<reference_def>& reference_defs,
  std::string_view anchor_id = {}
) {
  std::string out;
  if (anchor_id.empty()) {
    out.append("<tr>");
  } else {
    out.append("<tr id=\"");
    out.append(anchor_id);
    out.append("\">");
  }

  const std::size_t column_count = std::max(cells.size(), alignments.size());
  for (std::size_t index = 0; index < column_count; ++index) {
    const bool has_cell = index < cells.size();
    const std::string_view cell = has_cell ? cells[index] : std::string_view{};
    const table_alignment alignment = index < alignments.size() ? alignments[index] : table_alignment::none;
    out.append(header ? "<th" : "<td");
    out.append(table_alignment_attribute(alignment));
    out.append(">");
    if (has_cell) {
      out.append(render_inline(cell, request, footnote_refs, reference_defs));
    }
    out.append(header ? "</th>" : "</td>");
  }

  out.append("</tr>");
  return out;
}

std::size_t find_next_table_body_row(
  const std::vector<std::string_view>& lines,
  std::size_t cursor
) {
  if (cursor >= lines.size()) {
    return std::string_view::npos;
  }
  if (trim(lines[cursor]).empty()) {
    cursor = find_next_non_empty_line(lines, cursor + 1);
    if (cursor == std::string_view::npos) {
      return cursor;
    }
  }
  const auto row = trim(lines[cursor]);
  std::vector<table_alignment> ignored;
  return row.find('|') == std::string_view::npos || parse_table_separator_row(row, ignored)
    ? std::string_view::npos : cursor;
}

std::string render_table_block(
  const std::vector<std::string_view>& lines,
  std::size_t& index,
  const render_request& request,
  std::vector<std::string>& footnote_refs,
  const std::vector<reference_def>& reference_defs,
  const std::vector<std::string_view>* line_end_anchors = nullptr
) {
  if (index + 1 >= lines.size()) {
    return {};
  }

  const std::size_t separator_index = find_next_non_empty_line(lines, index + 1);
  if (separator_index == std::string_view::npos) {
    return {};
  }

  const std::string_view header_row = trim(lines[index]);
  const std::string_view separator_row = trim(lines[separator_index]);
  std::vector<table_alignment> alignments;
  if (!parse_table_separator_row(separator_row, alignments)) {
    return {};
  }

  const std::vector<std::string> header_cells = split_table_cells(header_row);
  if (header_cells.empty()) {
    return {};
  }

  std::string html;
  const std::string_view header_anchor =
    line_end_anchors && index < line_end_anchors->size() ? (*line_end_anchors)[index] : std::string_view{};
  html.append("<table><thead>");
  html.append(render_table_row(header_cells, true, alignments, request, footnote_refs, reference_defs, header_anchor));
  html.append("</thead><tbody>");

  std::size_t cursor = separator_index + 1;
  while (cursor < lines.size()) {
    const auto row_index = find_next_table_body_row(lines, cursor);
    if (row_index == std::string_view::npos) {
      break;
    }
    cursor = row_index;
    const std::string_view row = trim(lines[cursor]);

    const std::string_view row_anchor =
      line_end_anchors && cursor < line_end_anchors->size() ? (*line_end_anchors)[cursor] : std::string_view{};
    html.append(render_table_row(split_table_cells(row), false, alignments, request, footnote_refs, reference_defs, row_anchor));
    ++cursor;
  }

  html.append("</tbody></table>");
  index = cursor > 0 ? cursor - 1 : index;
  return html;
}

std::string render_blockquote(
  const std::vector<std::string_view>& lines,
  std::size_t& index,
  const render_request& request,
  std::vector<std::string>& footnote_refs,
  std::vector<footnote_def>& footnote_defs,
  std::vector<reference_def>& reference_defs,
  const std::vector<std::size_t>& line_columns
) {
  std::string inner;
  std::vector<std::size_t> inner_columns;
  bool first_line = true;

  while (index < lines.size()) {
    const std::string_view raw_line = lines[index];
    const std::string_view trimmed = trim_left(raw_line);
    if (trimmed.empty() || trimmed.front() != '>') {
      break;
    }

    const auto content = strip_blockquote_prefix(raw_line, line_columns[index]);
    if (!first_line) {
      inner.push_back('\n');
    }
    inner.append(content.source);
    inner_columns.push_back(content.column);
    first_line = false;
    ++index;
  }

  if (inner.empty()) {
    return {};
  }

  // Pass down both footnote_refs and footnote_defs
  return "<blockquote>" + render_document_v2(inner, request, footnote_refs, footnote_defs, reference_defs, false, &inner_columns) + "</blockquote>";
}

std::string render_paragraph_group(
  const std::vector<std::string_view>& lines,
  std::size_t& index,
  const render_request& request,
  std::vector<std::string>& footnote_refs,
  std::vector<footnote_def>& footnote_defs,
  std::vector<reference_def>& reference_defs
) {
  if (!is_paragraph_group_start(lines[index])) {
    return {};
  }

  std::string inner;
  bool first_line = true;
  std::size_t depth = 1;
  std::size_t cursor = index + 1;

  while (cursor < lines.size()) {
    const std::string_view line = lines[cursor];
    if (is_paragraph_group_start(line)) {
      ++depth;
    } else if (is_paragraph_group_end(line)) {
      --depth;
      if (depth == 0) {
        break;
      }
    }

    if (!first_line) {
      inner.push_back('\n');
    }
    inner.append(line.data(), line.size());
    first_line = false;
    ++cursor;
  }

  if (cursor >= lines.size() || depth != 0) {
    return {};
  }

  index = cursor;
  return "<section class=\"markdown-renderer__paragraph\" data-fsus-paragraph>"
    + render_document_v2(inner, request, footnote_refs, footnote_defs, reference_defs, false)
    + "</section>";
}

bool is_valid_block_anchor_id(std::string_view id) {
  if (id.empty() || id.size() > 64) {
    return false;
  }
  if (id[0] < 'a' || id[0] > 'z') {
    return false;
  }
  for (std::size_t index = 1; index < id.size(); ++index) {
    const char ch = id[index];
    const bool valid =
      (ch >= 'a' && ch <= 'z') ||
      (ch >= '0' && ch <= '9') ||
      ch == '-';
    if (!valid) {
      return false;
    }
  }
  return true;
}

bool match_fence_open_prefix(std::string_view line, char& delimiter_out, std::size_t& count_out) {
  std::size_t indent = 0;
  while (indent < line.size() && indent < 3 && (line[indent] == ' ' || line[indent] == '\t')) {
    ++indent;
  }
  if (indent < line.size() && (line[indent] == ' ' || line[indent] == '\t')) {
    return false;
  }
  if (indent >= line.size() || (line[indent] != '`' && line[indent] != '~')) {
    return false;
  }
  const char marker = line[indent];
  std::size_t run = 0;
  while (indent + run < line.size() && line[indent + run] == marker) {
    ++run;
  }
  if (run < 3) {
    return false;
  }
  delimiter_out = marker;
  count_out = run;
  return true;
}

bool match_fence_close_line(std::string_view line, char delimiter, std::size_t min_count) {
  char found_delimiter = '\0';
  std::size_t count = 0;
  if (!match_fence_open_prefix(line, found_delimiter, count) || found_delimiter != delimiter || count < min_count) {
    return false;
  }
  std::size_t cursor = 0;
  while (cursor < line.size() && (line[cursor] == ' ' || line[cursor] == '\t')) {
    ++cursor;
  }
  cursor += count;
  while (cursor < line.size() && (line[cursor] == ' ' || line[cursor] == '\t' || line[cursor] == '\r')) {
    ++cursor;
  }
  return cursor == line.size();
}

bool is_atomic_anchor_owner_line(std::string_view line) {
  std::size_t indent = 0;
  while (indent < line.size() && indent < 3 && (line[indent] == ' ' || line[indent] == '\t')) {
    ++indent;
  }
  if (indent < line.size() && (line[indent] == ' ' || line[indent] == '\t')) {
    return false;
  }
  const std::string_view after_indent = line.substr(indent);
  char fence_delim = '\0';
  std::size_t fence_count = 0;
  if (match_fence_open_prefix(line, fence_delim, fence_count)) {
    return true;
  }
  if (after_indent.starts_with("$$") || after_indent.starts_with(":::")) {
    return true;
  }
  if (after_indent.starts_with("::") && after_indent.size() > 3 && after_indent[2] >= 'a' && after_indent[2] <= 'z') {
    std::size_t cursor = 2;
    while (cursor < after_indent.size() && ((after_indent[cursor] >= 'a' && after_indent[cursor] <= 'z') || (after_indent[cursor] >= '0' && after_indent[cursor] <= '9') || after_indent[cursor] == '-')) {
      ++cursor;
    }
    if (cursor < after_indent.size() && after_indent[cursor] == '[') {
      return true;
    }
  }
  return false;
}

std::vector<std::uint8_t> mark_atomic_anchor_regions(const std::vector<std::string_view>& lines) {
  std::vector<std::uint8_t> inside(lines.size(), 0);
  char fence_delim = '\0';
  std::size_t fence_len = 0;
  bool in_latex = false;
  bool in_container = false;

  for (std::size_t index = 0; index < lines.size(); ++index) {
    const std::string_view line = lines[index];
    const std::string_view trimmed = trim(line);

    if (fence_len > 0) {
      inside[index] = 1;
      if (match_fence_close_line(line, fence_delim, fence_len)) {
        fence_delim = '\0';
        fence_len = 0;
      }
      continue;
    }

    if (in_latex) {
      inside[index] = 1;
      std::size_t indent = 0;
      while (indent < line.size() && indent < 3 && (line[indent] == ' ' || line[indent] == '\t')) {
        ++indent;
      }
      if (trim(line.substr(indent)) == "$$") {
        in_latex = false;
      }
      continue;
    }

    if (in_container) {
      inside[index] = 1;
      std::size_t indent = 0;
      while (indent < line.size() && indent < 3 && (line[indent] == ' ' || line[indent] == '\t')) {
        ++indent;
      }
      if (trim(line.substr(indent)) == ":::") {
        in_container = false;
      }
      continue;
    }

    if (match_fence_open_prefix(line, fence_delim, fence_len)) {
      inside[index] = 1;
      continue;
    }

    std::size_t indent = 0;
    while (indent < line.size() && indent < 3 && (line[indent] == ' ' || line[indent] == '\t')) {
      ++indent;
    }
    const std::string_view after_indent = line.substr(indent);
    if (after_indent.starts_with("$$") && indent == line.size() - after_indent.size()) {
      inside[index] = 1;
      const std::string_view rest = trim_right(after_indent.substr(2));
      if (!rest.ends_with("$$")) {
        in_latex = true;
      }
      continue;
    }
    if (after_indent.size() > 3 && after_indent.starts_with(":::") && after_indent[3] != ' ' && after_indent[3] != '\t' && after_indent[3] != '\r') {
      inside[index] = 1;
      in_container = true;
      continue;
    }
    (void)trimmed;
  }
  return inside;
}

bool parse_block_anchor_candidate(
  std::string_view line,
  std::string_view& id_out,
  std::size_t& strip_len_out,
  bool& exclusive_out
) {
  const std::size_t end = line.size();
  std::size_t token_start = end;
  while (token_start > 0) {
    const char ch = line[token_start - 1];
    const bool is_token =
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9') ||
      ch == '-' ||
      ch == '_';
    if (!is_token) {
      break;
    }
    --token_start;
  }
  if (token_start == 0 || token_start == end || line[token_start - 1] != '^') {
    return false;
  }
  const std::size_t caret = token_start - 1;
  const std::string_view id_candidate = line.substr(token_start, end - token_start);
  if (caret == 0) {
    if (!is_valid_block_anchor_id(id_candidate)) {
      return false;
    }
    id_out = id_candidate;
    strip_len_out = 0;
    exclusive_out = true;
    return true;
  }
  if (line[caret - 1] != ' ' ||
      (caret >= 2 && (line[caret - 2] == ' ' || line[caret - 2] == '\t'))) {
    return false;
  }
  const std::size_t strip_len = caret - 1;
  if (trim(line.substr(0, strip_len)).empty()) {
    return false;
  }
  if (!is_valid_block_anchor_id(id_candidate)) {
    return false;
  }
  id_out = id_candidate;
  strip_len_out = strip_len;
  exclusive_out = false;
  return true;
}

bool inject_block_anchor_id(std::string& block_html, std::string_view anchor_id) {
  if (anchor_id.empty() || block_html.empty() || block_html[0] != '<') {
    return false;
  }
  const std::size_t gt = block_html.find('>');
  if (gt == std::string::npos) {
    return false;
  }
  const std::string_view opening = std::string_view(block_html).substr(0, gt);
  if (opening.find(" id=\"") != std::string_view::npos) {
    return false;
  }
  const std::size_t pos = block_html.find_first_of(" >/", 1);
  if (pos == std::string::npos || pos > gt) {
    return false;
  }
  block_html.insert(pos, " id=\"" + std::string(anchor_id) + "\"");
  return true;
}

std::string render_document_v2(
  std::string_view source,
  const render_request& request,
  std::vector<std::string>& footnote_refs,
  std::vector<footnote_def>& footnote_defs,
  std::vector<reference_def>& reference_defs,
  bool is_top_level,
  const std::vector<std::size_t>* column_origins,
  const std::vector<std::string_view>* inherited_line_anchors
) {
  if (source.empty()) {
    return {};
  }

  std::vector<std::string_view> raw_lines = split_lines(source);
  std::vector<std::string_view> lines;
  std::vector<std::size_t> line_columns;
  std::vector<std::string_view> line_end_anchors;
  lines.reserve(raw_lines.size());
  line_columns.reserve(raw_lines.size());

  // First pass: collect footnote/reference definitions and filter them out.
  for (std::size_t raw_index = 0; raw_index < raw_lines.size(); ++raw_index) {
    const auto& line = raw_lines[raw_index];
    const std::string_view trimmed = trim_left(line);
    if (trimmed.starts_with("[^")) {
      const std::size_t label_end = trimmed.find("]:");
      if (label_end != std::string_view::npos) {
        const std::string label = std::string(trimmed.substr(2, label_end - 2));
        const std::string content = std::string(trim_left(trimmed.substr(label_end + 2)));

        bool found = false;
        for (auto& def : footnote_defs) {
          if (def.label == label) {
            def.content = content; // Overwrite
            found = true;
            break;
          }
        }
        if (!found) {
          footnote_defs.push_back({label, content});
        }
        continue;
      }
    }

    if (trimmed.starts_with("[") && !trimmed.starts_with("[^")) {
      const std::size_t label_end = trimmed.find("]:");
      if (label_end != std::string_view::npos) {
        const std::string label = normalize_reference_label(trimmed.substr(1, label_end - 1));
        std::string_view destination = trim_left(trimmed.substr(label_end + 2));
        if (!label.empty() && !destination.empty()) {
          const std::size_t title_quote = destination.find('"');
          if (title_quote != std::string_view::npos) {
            destination = trim_right(destination.substr(0, title_quote));
          }
          const std::size_t title_apostrophe = destination.find('\'');
          if (title_apostrophe != std::string_view::npos) {
            destination = trim_right(destination.substr(0, title_apostrophe));
          }
          if (!destination.empty()) {
            bool found = false;
            for (auto& def : reference_defs) {
              if (def.label == label) {
                def.url = std::string(destination);
                found = true;
                break;
              }
            }
            if (!found) {
              reference_defs.push_back({label, std::string(destination)});
            }
            continue;
          }
        }
      }
    }
    lines.push_back(line);
    line_end_anchors.push_back(
      inherited_line_anchors && raw_index < inherited_line_anchors->size()
        ? (*inherited_line_anchors)[raw_index] : std::string_view{}
    );
    line_columns.push_back(column_origins ? (*column_origins)[raw_index] : 0);
  }

  std::vector<std::string_view> following_anchors(lines.size());
  std::vector<std::uint8_t> consumed_anchor_lines(lines.size(), 0);
  if (is_top_level && !lines.empty() && source.find('^') != std::string_view::npos) {
    const std::vector<std::uint8_t> inside_atomic = mark_atomic_anchor_regions(lines);
    const auto syntax = collect_anchor_owner_blocks(source);
    std::vector<syntax_range> final_line_owners;
    std::unordered_set<std::size_t> nested_list_starts;
    std::vector<syntax_range> code_regions;
    std::unordered_set<std::size_t> table_end_offsets;
    for (const auto& node : syntax) {
      if (node.kind == syntax_kind::paragraph || node.kind == syntax_kind::quote) {
        final_line_owners.push_back(node.range);
      } else if (node.kind == syntax_kind::list) {
        nested_list_starts.insert(node.range.start_offset);
      } else if (node.kind == syntax_kind::code) {
        code_regions.push_back(node.range);
      } else if (node.kind == syntax_kind::table) {
        table_end_offsets.insert(node.range.end_offset);
      }
    }
    auto candidate_is_final_owner_line = [&](const std::string_view line) {
      const auto start = static_cast<std::size_t>(line.data() - source.data());
      if (nested_list_starts.contains(start)) {
        // This line is copied into a child renderer with no source owner binding.
        return false;
      }
      const auto owner = std::upper_bound(
        final_line_owners.begin(), final_line_owners.end(), start,
        [](std::size_t offset, const syntax_range& paragraph) {
          return offset < paragraph.start_offset;
        }
      );
      if (owner == final_line_owners.begin() || start >= (owner - 1)->end_offset) {
        return true;
      }
      const auto end = start + line.size();
      return end == (owner - 1)->end_offset ||
        (end + 1 == (owner - 1)->end_offset && source[end] == '\n');
    };
    auto candidate_is_inside_code = [&](const std::string_view line) {
      const auto start = static_cast<std::size_t>(line.data() - source.data());
      const auto owner = std::upper_bound(
        code_regions.begin(), code_regions.end(), start,
        [](std::size_t offset, const syntax_range& region) {
          return offset < region.start_offset;
        }
      );
      return owner != code_regions.begin() && start < (owner - 1)->end_offset;
    };
    std::unordered_map<std::string_view, std::size_t> counts;
    std::vector<std::size_t> strip_lengths(lines.size());
    for (std::size_t line_idx = 0; line_idx < lines.size(); ++line_idx) {
      if (inside_atomic[line_idx]) {
        continue;
      }
      const std::string_view raw_line = lines[line_idx];
      if (!raw_line.empty() && raw_line[0] == '^' && raw_line != "^") {
        std::string_view parsed_id;
        std::size_t strip_len = 0;
        bool is_exclusive = false;
        if (!parse_block_anchor_candidate(raw_line, parsed_id, strip_len, is_exclusive) || !is_exclusive) {
          continue;
        }
        if (line_idx == 0) {
          continue;
        }
        const std::string_view previous_line = lines[line_idx - 1];
        const auto marker_start = static_cast<std::size_t>(raw_line.data() - source.data());
        if (previous_line.data() + previous_line.size() + 1 != raw_line.data() ||
            trim(previous_line).empty() ||
            !(table_end_offsets.contains(marker_start) || is_atomic_anchor_owner_line(previous_line))) {
          continue;
        }
        ++counts[parsed_id];
        following_anchors[line_idx - 1] = parsed_id;
        continue;
      }
      std::string_view parsed_id;
      std::size_t strip_len = 0;
      bool is_exclusive = false;
      if (!parse_block_anchor_candidate(raw_line, parsed_id, strip_len, is_exclusive) ||
          is_exclusive || candidate_is_inside_code(raw_line) ||
          !candidate_is_final_owner_line(raw_line)) {
        continue;
      }
      ++counts[parsed_id];
      line_end_anchors[line_idx] = parsed_id;
      strip_lengths[line_idx] = strip_len;
    }
    // Keep rejected marker text in the original lines. Only unique eligible
    // owner claims may alter a line or emit an ID.
    for (std::size_t index = 0; index < lines.size(); ++index) {
      auto& inline_id = line_end_anchors[index];
      if (!inline_id.empty()) {
        if (counts.at(inline_id) == 1) {
          lines[index] = lines[index].substr(0, strip_lengths[index]);
        } else {
          inline_id = {};
        }
      }
      auto& following_id = following_anchors[index];
      if (!following_id.empty() && counts.at(following_id) > 1) {
        following_id = {};
      }
    }
  }

  std::string html;
  html.reserve(source.size() + 256);

  std::string paragraph;
  std::string_view paragraph_anchor;
  std::vector<std::string> list_items;
  std::vector<std::string_view> list_item_anchors;
  std::vector<std::vector<std::string_view>> child_line_anchors;
  bool list_ordered = false;
  bool in_code_block = false;
  bool in_latex_block = false;
  char fence_char = '`';
  std::string_view fence_lang;
  std::string code_buffer;
  std::string latex_buffer;

  auto attach_following_anchor = [&](std::size_t owner_line, std::string& block_html) {
    if (owner_line >= following_anchors.size() || following_anchors[owner_line].empty()) {
      return;
    }
    if (inject_block_anchor_id(block_html, following_anchors[owner_line]) && owner_line + 1 < consumed_anchor_lines.size()) {
      consumed_anchor_lines[owner_line + 1] = 1;
    }
  };

  auto flush_paragraph = [&]() {
    const std::string_view trimmed = trim(paragraph);
    if (!trimmed.empty()) {
      html.append("<p");
      if (!paragraph_anchor.empty()) {
        html.append(" id=\"");
        html.append(paragraph_anchor);
        html.push_back('"');
      }
      html.append(inline_flow_class_attr(
        trimmed,
        "markdown-renderer__text",
        "markdown-renderer__text--inline-code"
      ));
      html.push_back('>');
      html.append(render_inline(trimmed, request, footnote_refs, reference_defs));
      html.append("</p>");
    }
    paragraph.clear();
    paragraph_anchor = {};
  };

  auto flush_list = [&]() {
    if (list_items.empty()) {
      return;
    }
    html.append(render_list(list_items, list_ordered, request, footnote_refs, footnote_defs, reference_defs, &list_item_anchors, &child_line_anchors));
    list_items.clear();
    list_item_anchors.clear();
    child_line_anchors.clear();
  };

  std::size_t mermaid_diagram_index = 0;

  auto flush_code = [&](std::size_t closing_line) {
    if (code_buffer.empty()) {
      return;
    }

    const std::string_view language = trim(fence_lang);
    const std::string_view code_view = code_buffer;
    const bool is_mermaid = language == "mermaid";
    std::string block_html = (is_mermaid && request.allow_mermaid)
      ? mermaid::render_block(code_view, mermaid_diagram_index++)
      : escape_and_wrap_code(code_view, language);
    attach_following_anchor(closing_line, block_html);
    html.append(block_html);
    code_buffer.clear();
    fence_lang = {};
  };

  auto flush_latex = [&](std::size_t closing_line) {
    if (latex_buffer.empty()) {
      return;
    }

    std::string block_html = request.allow_latex
      ? latex::render_fragment({
          latex_buffer,
          latex::fragment_kind::block_math
        })
      : escape_and_wrap_code(latex_buffer, "latex");
    attach_following_anchor(closing_line, block_html);
    html.append(block_html);
    latex_buffer.clear();
  };

  for (std::size_t index = 0; index < lines.size(); ++index) {
    const std::string_view line = lines[index];
    const std::string_view trimmed = trim(line);

    if (in_code_block) {
      if (parse_fence_end(line, fence_char)) {
        in_code_block = false;
        flush_code(index);
      } else {
        code_buffer.append(line.data(), line.size());
        code_buffer.push_back('\n');
      }
      continue;
    }

    if (in_latex_block) {
      if (trimmed == "$$") {
        in_latex_block = false;
        flush_latex(index);
      } else {
        latex_buffer.append(line.data(), line.size());
        latex_buffer.push_back('\n');
      }
      continue;
    }

    if (consumed_anchor_lines[index]) {
      continue;
    }

    if (trimmed.empty()) {
      flush_paragraph();
      // Loose-list handling: a blank line must not terminate the list if the
      // next non-blank line is an indented list continuation (≥2 spaces).
      if (!list_items.empty()) {
        std::size_t lookahead = index + 1;
        while (lookahead < lines.size() && trim(lines[lookahead]).empty()) {
          ++lookahead;
        }
        if (lookahead < lines.size()) {
          if (continues_nested_list(lines[lookahead])) {
            list_items.back().push_back('\n');
            child_line_anchors.back().emplace_back();
            continue;
          }
        }
      }
      flush_list();
      continue;
    }

    if (is_paragraph_group_start(line)) {
      flush_paragraph();
      flush_list();
      std::size_t group_index = index;
      const std::string group_html = render_paragraph_group(lines, group_index, request, footnote_refs, footnote_defs, reference_defs);
      if (!group_html.empty()) {
        html.append(group_html);
        index = group_index;
        continue;
      }
    }

    if (trimmed.front() == '>') {
      flush_paragraph();
      flush_list();
      std::size_t quote_index = index;
      std::string quote_html = render_blockquote(lines, quote_index, request, footnote_refs, footnote_defs, reference_defs, line_columns);
      if (!quote_html.empty()) {
        if (quote_index > index) {
          inject_block_anchor_id(quote_html, line_end_anchors[quote_index - 1]);
        }
        html.append(quote_html);
        index = quote_index;
      }
      continue;
    }

    if (is_horizontal_rule(line)) {
      flush_paragraph();
      flush_list();
      html.append("<hr />");
      continue;
    }

    if (index + 1 < lines.size()) {
      const int setext_level = parse_setext_heading_level(lines[index + 1]);
      char setext_fence_char = '\0';
      std::string_view setext_fence_lang;
      if (setext_level > 0 && !trimmed.empty() && trimmed.front() != '>' && !is_indented_code_line(line, line_columns[index]) && !parse_fence_start(line, setext_fence_char, setext_fence_lang)) {
        flush_paragraph();
        flush_list();
        html.append(setext_level == 1 ? "<h1" : "<h2");
        if (!line_end_anchors[index].empty()) {
          html.append(" id=\"");
          html.append(line_end_anchors[index]);
          html.push_back('"');
        }
        html.push_back('>');
        html.append(render_inline(trimmed, request, footnote_refs, reference_defs));
        html.append(setext_level == 1 ? "</h1>" : "</h2>");
        ++index;
        continue;
      }
    }

    if (trimmed.front() == '#' && !is_indented_code_line(line, line_columns[index])) {
      const std::string heading_html = render_heading(line, request, footnote_refs, reference_defs, line_end_anchors[index]);
      if (!heading_html.empty()) {
        flush_paragraph();
        flush_list();
        html.append(heading_html);
      } else {
        if (!paragraph.empty()) {
          paragraph.push_back(' ');
        }
        if (paragraph_anchor.empty() && !line_end_anchors[index].empty()) {
          paragraph_anchor = line_end_anchors[index];
        }
        paragraph.append(trimmed.data(), trimmed.size());
      }
      continue;
    }

    if (parse_fence_start(line, fence_char, fence_lang)) {
      flush_paragraph();
      flush_list();
      in_code_block = true;
      code_buffer.clear();
      continue;
    }

    // List continuation must be checked before indented-code detection to avoid
    // misidentifying deeply-indented (≥4 space) list items as code blocks.
    if (!list_items.empty() && continues_nested_list(line)) {
      list_items.back().push_back('\n');
      child_line_anchors.back().push_back(line_end_anchors[index]);
      // Strip exactly 2 chars to preserve relative indentation for multi-level nesting.
      list_items.back().append(line.data() + 2, line.size() - 2);
      continue;
    }

    if (is_indented_code_line(line, line_columns[index])) {
      flush_paragraph();
      flush_list();
      std::string indented_code;
      std::size_t code_index = index;
      while (code_index < lines.size()) {
        if (trim(lines[code_index]).empty()) {
          indented_code.push_back('\n');
          ++code_index;
          continue;
        }
        if (!is_indented_code_line(lines[code_index], line_columns[code_index])) {
          break;
        }
        const std::string code_line = strip_code_indent(lines[code_index], line_columns[code_index]);
        indented_code.append(code_line.data(), code_line.size());
        indented_code.push_back('\n');
        ++code_index;
      }
      html.append(escape_and_wrap_code(indented_code));
      index = code_index > 0 ? code_index - 1 : index;
      continue;
    }

    if (trimmed.starts_with(":::mermaid")) {
      flush_paragraph();
      flush_list();
      std::string mermaid_buffer;
      std::size_t mermaid_index = index + 1;
      while (mermaid_index < lines.size()) {
        const std::string_view mermaid_line = trim(lines[mermaid_index]);
        if (mermaid_line == ":::" ) {
          break;
        }
        mermaid_buffer.append(lines[mermaid_index].data(), lines[mermaid_index].size());
        mermaid_buffer.push_back('\n');
        ++mermaid_index;
      }

      std::string mermaid_html = request.allow_mermaid
        ? mermaid::render_block(mermaid_buffer, mermaid_diagram_index++)
        : escape_and_wrap_code(mermaid_buffer, "mermaid");
      attach_following_anchor(mermaid_index, mermaid_html);
      html.append(mermaid_html);

      index = mermaid_index;
      continue;
    }

    if (trimmed.starts_with("$$")) {
      flush_paragraph();
      flush_list();
      if (trimmed.size() > 4 && trimmed.ends_with("$$")) {
        std::string latex_html = request.allow_latex
          ? latex::render_fragment({
              trimmed.substr(2, trimmed.size() - 4),
              latex::fragment_kind::block_math
            })
          : escape_and_wrap_code(trimmed.substr(2, trimmed.size() - 4), "latex");
        attach_following_anchor(index, latex_html);
        html.append(latex_html);
      } else {
        in_latex_block = true;
        latex_buffer.clear();
        if (trimmed.size() > 2) {
          latex_buffer.append(trimmed.substr(2));
          latex_buffer.push_back('\n');
        }
      }
      continue;
    }

    if (index + 1 < lines.size() && trimmed.find('|') != std::string_view::npos) {
      flush_paragraph();
      flush_list();
      std::size_t table_index = index;
      std::string table_html = render_table_block(lines, table_index, request, footnote_refs, reference_defs, &line_end_anchors);
      if (!table_html.empty()) {
        attach_following_anchor(table_index, table_html);
        html.append(table_html);
        index = table_index;
        continue;
      }
    }

    std::string_view list_item;

    if (parse_unordered_list_item(line, list_item)) {
      flush_paragraph();
      if (!list_items.empty() && list_ordered) {
        html.append(render_list(list_items, list_ordered, request, footnote_refs, footnote_defs, reference_defs, &list_item_anchors, &child_line_anchors));
        list_items.clear();
        list_item_anchors.clear();
        child_line_anchors.clear();
      }
      list_ordered = false;
      list_items.emplace_back(list_item);
      list_item_anchors.push_back(line_end_anchors[index]);
      child_line_anchors.push_back({{}});
      continue;
    }

    if (parse_ordered_list_item(line, list_item)) {
      flush_paragraph();
      if (!list_items.empty() && !list_ordered) {
        html.append(render_list(list_items, list_ordered, request, footnote_refs, footnote_defs, reference_defs, &list_item_anchors, &child_line_anchors));
        list_items.clear();
        list_item_anchors.clear();
        child_line_anchors.clear();
      }
      list_ordered = true;
      list_items.emplace_back(list_item);
      list_item_anchors.push_back(line_end_anchors[index]);
      child_line_anchors.push_back({{}});
      continue;
    }

    flush_list();
    if (!paragraph.empty()) {
      paragraph.push_back(' ');
    }
    if (paragraph_anchor.empty() && !line_end_anchors[index].empty()) {
      paragraph_anchor = line_end_anchors[index];
    }
    paragraph.append(trimmed.data(), trimmed.size());
  }

  if (in_code_block) {
    flush_code(lines.size());
  }
  if (in_latex_block) {
    flush_latex(lines.size());
  }
  flush_paragraph();
  flush_list();

  // Final section: render used footnotes
  if (is_top_level && !footnote_refs.empty()) {
    html.append("<section class=\"footnotes\"><hr /><ol>");
    for (std::size_t i = 0; i < footnote_refs.size(); ++i) {
      const auto& label = footnote_refs[i];
      html.append("<li id=\"fn-");
      html.append(escape_html(label));
      html.append("\">");

      // Find content
      std::string content;
      for (const auto& def : footnote_defs) {
        if (def.label == label) {
          content = def.content;
          break;
        }
      }

      if (content.empty()) {
          content = "<em>[Footnote content missing]</em>";
      }

      html.append(render_inline(content, request, footnote_refs, reference_defs));
      html.append(" <a href=\"#fnref-");
      html.append(escape_html(label));
      html.append("\" class=\"footnote-backref\">↩</a></li>");
    }
    html.append("</ol></section>");
  }

  return html;
}

std::string render_document(std::string_view source, const render_request& request) {
  std::vector<std::string> footnote_refs;
  std::vector<footnote_def> footnote_defs;
  std::vector<reference_def> reference_defs;
  return render_document_v2(source, request, footnote_refs, footnote_defs, reference_defs, true);
}

struct SourceLine {
  std::string_view text;
  std::size_t start;
  std::size_t end;
};

void append_syntax_range(
  std::vector<syntax_range>& ranges,
  std::size_t start,
  std::size_t end
) {
  if (start < end) {
    ranges.push_back({start, end});
  }
}

std::size_t syntax_content_end(std::string_view source, std::size_t end) {
  while (end > 0 && end <= source.size() && (source[end - 1] == '\n' || source[end - 1] == '\r')) {
    --end;
  }
  return end;
}

void decorate_inline_syntax(std::string_view source, syntax_node& node) {
  const std::size_t end = syntax_content_end(source, node.end_offset);
  if (node.start_offset >= end) {
    return;
  }
  const std::string_view text = source.substr(node.start_offset, end - node.start_offset);
  if (node.kind == syntax_kind::latex && text.size() >= 4 && text[0] == '\\') {
    append_syntax_range(node.marker_ranges, node.start_offset, node.start_offset + 2);
    append_syntax_range(node.content_ranges, node.start_offset + 2, end - 2);
    append_syntax_range(node.marker_ranges, end - 2, end);
    return;
  }
  if (node.kind == syntax_kind::footnote && text.starts_with("[^")) {
    const std::size_t close = text.find(']');
    if (close != std::string_view::npos) {
      append_syntax_range(node.marker_ranges, node.start_offset, node.start_offset + 2);
      append_syntax_range(node.content_ranges, node.start_offset + 2, node.start_offset + close);
      if (close + 1 < text.size() && text[close + 1] == ':') {
        append_syntax_range(node.marker_ranges, node.start_offset + close, node.start_offset + close + 2);
        std::size_t body = close + 2;
        while (body < text.size() && (text[body] == ' ' || text[body] == '\t')) {
          ++body;
        }
        append_syntax_range(node.content_ranges, node.start_offset + body, end);
      } else {
        append_syntax_range(node.marker_ranges, node.start_offset + close, node.start_offset + close + 1);
      }
      return;
    }
  }
  if ((node.kind == syntax_kind::link || node.kind == syntax_kind::image) && text.front() == '<') {
    append_syntax_range(node.marker_ranges, node.start_offset, node.start_offset + 1);
    append_syntax_range(node.content_ranges, node.start_offset + 1, end - 1);
    append_syntax_range(node.marker_ranges, end - 1, end);
    return;
  }
  if (node.kind == syntax_kind::link || node.kind == syntax_kind::image) {
    const bool image = node.kind == syntax_kind::image;
    const std::size_t label_open = image ? 1 : 0;
    const std::size_t label_end = text.find(']', label_open + 1);
    if (image) {
      append_syntax_range(node.marker_ranges, node.start_offset, node.start_offset + 2);
    } else {
      append_syntax_range(node.marker_ranges, node.start_offset, node.start_offset + 1);
    }
    if (label_end != std::string_view::npos) {
      append_syntax_range(
        node.content_ranges,
        node.start_offset + label_open + 1,
        node.start_offset + label_end
      );
      if (label_end + 1 < text.size() && (text[label_end + 1] == '(' || text[label_end + 1] == '[')) {
        append_syntax_range(
          node.marker_ranges,
          node.start_offset + label_end,
          node.start_offset + label_end + 2
        );
        append_syntax_range(
          node.content_ranges,
          node.start_offset + label_end + 2,
          end - 1
        );
        append_syntax_range(node.marker_ranges, end - 1, end);
      } else {
        append_syntax_range(
          node.marker_ranges,
          node.start_offset + label_end,
          node.start_offset + label_end + 1
        );
      }
      return;
    }
  }
  append_syntax_range(node.content_ranges, node.start_offset, end);
}

void decorate_line_syntax(std::string_view source, syntax_node& node) {
  std::size_t line_start = node.start_offset;
  while (line_start < node.end_offset) {
    const std::size_t newline = source.find('\n', line_start);
    const std::size_t line_end = std::min(
      newline == std::string_view::npos ? source.size() : newline,
      node.end_offset
    );
    const std::string_view line = source.substr(line_start, line_end - line_start);
    std::size_t cursor = 0;
    while (cursor < line.size() && (line[cursor] == ' ' || line[cursor] == '\t')) {
      ++cursor;
    }
    if (node.kind == syntax_kind::quote && cursor < line.size() && line[cursor] == '>') {
      std::size_t marker_end = cursor + 1;
      if (marker_end < line.size() && line[marker_end] == ' ') {
        ++marker_end;
      }
      append_syntax_range(node.marker_ranges, line_start + cursor, line_start + marker_end);
      append_syntax_range(node.content_ranges, line_start + marker_end, line_end);
    } else if (node.kind == syntax_kind::list || node.kind == syntax_kind::task) {
      std::size_t marker_end = cursor;
      if (marker_end < line.size() && (line[marker_end] == '-' || line[marker_end] == '*' || line[marker_end] == '+')) {
        ++marker_end;
      } else {
        while (marker_end < line.size() && is_digit(line[marker_end])) {
          ++marker_end;
        }
        if (marker_end < line.size() && (line[marker_end] == '.' || line[marker_end] == ')')) {
          ++marker_end;
        }
      }
      if (marker_end > cursor) {
        while (marker_end < line.size() && line[marker_end] == ' ') {
          ++marker_end;
        }
        if (
          node.kind == syntax_kind::task &&
          marker_end + 2 < line.size() &&
          line[marker_end] == '[' &&
          line[marker_end + 2] == ']'
        ) {
          marker_end += 3;
          while (marker_end < line.size() && line[marker_end] == ' ') {
            ++marker_end;
          }
        }
        append_syntax_range(node.marker_ranges, line_start + cursor, line_start + marker_end);
        append_syntax_range(node.content_ranges, line_start + marker_end, line_end);
      } else {
        append_syntax_range(node.content_ranges, line_start, line_end);
      }
    }
    if (newline == std::string_view::npos || newline >= node.end_offset) {
      break;
    }
    line_start = newline + 1;
  }
}

void decorate_table_syntax(std::string_view source, syntax_node& node) {
  std::size_t line_start = node.start_offset;
  while (line_start < node.end_offset) {
    const std::size_t newline = source.find('\n', line_start);
    const std::size_t line_end = std::min(
      newline == std::string_view::npos ? source.size() : newline,
      node.end_offset
    );
    const std::string_view line = source.substr(line_start, line_end - line_start);
    // The envelope can span blank separators between actual rendered rows.
    if (trim(line).empty()) {
      if (newline == std::string_view::npos || newline >= node.end_offset) {
        break;
      }
      line_start = newline + 1;
      continue;
    }
    const std::size_t row_index = node.table_row_ranges.size();
    node.table_row_ranges.push_back({line_start, line_end});
    std::vector<std::size_t> delimiters;
    const auto cell_ranges = table_cell_source_ranges(line, &delimiters);
    std::vector<syntax_range> absolute_cell_ranges;
    absolute_cell_ranges.reserve(cell_ranges.size());
    for (const auto& range : cell_ranges) {
      absolute_cell_ranges.push_back({
        line_start + range.start,
        line_start + range.end,
      });
    }
    node.table_cell_ranges.push_back(std::move(absolute_cell_ranges));

    std::vector<table_alignment> alignments;
    if (parse_table_separator_row(line, alignments)) {
      node.table_separator_row = row_index;
      node.table_alignments = alignments;
      const std::string_view trimmed = trim(line);
      const std::size_t offset = line.find(trimmed);
      append_syntax_range(node.marker_ranges, line_start + offset, line_start + offset + trimmed.size());
    } else {
      for (const auto& range : cell_ranges) {
        append_syntax_range(
          node.content_ranges,
          line_start + range.start,
          line_start + range.end
        );
      }
      for (const std::size_t delimiter : delimiters) {
        append_syntax_range(
          node.marker_ranges,
          line_start + delimiter,
          line_start + delimiter + 1
        );
      }
    }
    if (newline == std::string_view::npos || newline >= node.end_offset) {
      break;
    }
    line_start = newline + 1;
  }
}

void decorate_block_syntax(std::string_view source, syntax_node& node) {
  const std::size_t end = syntax_content_end(source, node.end_offset);
  if (node.start_offset >= end) {
    return;
  }
  const std::string_view text = source.substr(node.start_offset, end - node.start_offset);
  const std::size_t first_newline = text.find('\n');
  if (node.kind == syntax_kind::heading) {
    const std::string_view first_line = first_newline == std::string_view::npos
      ? text
      : text.substr(0, first_newline);
    const std::string_view trimmed = trim_left(first_line);
    const std::size_t indent = first_line.size() - trimmed.size();
    if (!trimmed.empty() && trimmed.front() == '#') {
      std::size_t marker_end = 0;
      while (marker_end < trimmed.size() && trimmed[marker_end] == '#') {
        ++marker_end;
      }
      while (marker_end < trimmed.size() && trimmed[marker_end] == ' ') {
        ++marker_end;
      }
      append_syntax_range(
        node.marker_ranges,
        node.start_offset + indent,
        node.start_offset + indent + marker_end
      );
      std::size_t content_end = trimmed.size();
      while (content_end > marker_end && trimmed[content_end - 1] == ' ') {
        --content_end;
      }
      std::size_t closing = content_end;
      while (closing > marker_end && trimmed[closing - 1] == '#') {
        --closing;
      }
      if (closing < content_end && closing > marker_end && trimmed[closing - 1] == ' ') {
        append_syntax_range(
          node.marker_ranges,
          node.start_offset + indent + closing - 1,
          node.start_offset + indent + content_end
        );
        content_end = closing - 1;
      }
      append_syntax_range(
        node.content_ranges,
        node.start_offset + indent + marker_end,
        node.start_offset + indent + content_end
      );
      return;
    }
    if (first_newline != std::string_view::npos) {
      append_syntax_range(node.content_ranges, node.start_offset, node.start_offset + first_newline);
      append_syntax_range(node.marker_ranges, node.start_offset + first_newline + 1, end);
      return;
    }
  }
  if (node.kind == syntax_kind::list || node.kind == syntax_kind::task || node.kind == syntax_kind::quote) {
    decorate_line_syntax(source, node);
    return;
  }
  if (node.kind == syntax_kind::table) {
    decorate_table_syntax(source, node);
    return;
  }
  if (
    node.kind == syntax_kind::latex &&
    text.size() >= 4 &&
    text.front() == '\\'
  ) {
    decorate_inline_syntax(source, node);
    return;
  }
  if (
    node.status == syntax_status::malformed &&
    node.diagnostic_code.starts_with("unclosed-")
  ) {
    const std::size_t open_end = first_newline == std::string_view::npos
      ? end
      : node.start_offset + first_newline;
    append_syntax_range(node.marker_ranges, node.start_offset, open_end);
    append_syntax_range(
      node.content_ranges,
      std::min(end, open_end + 1),
      end
    );
    return;
  }
  if (
    node.kind == syntax_kind::code ||
    node.kind == syntax_kind::mermaid ||
    node.kind == syntax_kind::latex ||
    node.kind == syntax_kind::explicit_paragraph
  ) {
    const std::size_t open_end = first_newline == std::string_view::npos ? end : node.start_offset + first_newline;
    const std::size_t last_line_start = text.rfind('\n');
    const std::size_t close_start = last_line_start == std::string_view::npos
      ? end
      : node.start_offset + last_line_start + 1;
    append_syntax_range(node.marker_ranges, node.start_offset, open_end);
    if (close_start > open_end) {
      append_syntax_range(
        node.content_ranges,
        std::min(end, open_end + 1),
        std::min(end, close_start)
      );
      append_syntax_range(node.marker_ranges, close_start, end);
    }
    return;
  }
  decorate_inline_syntax(source, node);
}

bool is_atx_heading_line(std::string_view line) {
  if (is_indented_code_line(line)) {
    return false;
  }
  const std::string_view trimmed = trim_left(line);
  std::size_t level = 0;
  while (level < trimmed.size() && trimmed[level] == '#') {
    ++level;
  }
  return level >= 1 && level <= 6 && (level == trimmed.size() || trimmed[level] == ' ');
}

bool is_footnote_definition_line(std::string_view line) {
  const std::string_view trimmed = trim_left(line);
  if (!trimmed.starts_with("[^")) {
    return false;
  }
  return trimmed.find("]:") != std::string_view::npos;
}

bool is_reference_definition_line(std::string_view line) {
  const std::string_view trimmed = trim_left(line);
  if (!trimmed.starts_with("[") || trimmed.starts_with("[^")) {
    return false;
  }
  const std::size_t label_end = trimmed.find("]:");
  if (label_end == std::string_view::npos) {
    return false;
  }
  std::string_view destination = trim_left(trimmed.substr(label_end + 2));
  return !normalize_reference_label(trimmed.substr(1, label_end - 1)).empty() &&
    !destination.empty();
}

std::size_t exclusive_line_end(std::string_view source, const SourceLine& line) {
  if (line.end < source.size()) {
    return line.end + 1;
  }
  return line.end;
}

bool skip_inline_code_span(std::string_view text, std::size_t index, std::size_t& next_index) {
  std::string ignored;
  return try_render_code_span(text, index, ignored, next_index);
}

bool skip_inline_latex(std::string_view text, std::size_t index, std::size_t& next_index) {
  if (index + 1 >= text.size() || text[index] != '\\') {
    return false;
  }
  if (text[index + 1] != '(' && text[index + 1] != '[') {
    return false;
  }
  const std::string_view needle = text[index + 1] == '(' ? std::string_view{"\\)"} : std::string_view{"\\]"};
  const std::size_t close = text.find(needle, index + 2);
  if (close == std::string_view::npos) {
    return false;
  }
  next_index = close + 2;
  return true;
}

bool match_autolink(std::string_view text, std::size_t index, std::size_t& end_offset) {
  if (index >= text.size() || text[index] != '<') {
    return false;
  }
  const std::size_t close = text.find('>', index + 1);
  if (close == std::string_view::npos) {
    return false;
  }
  const std::string_view target = text.substr(index + 1, close - index - 1);
  const std::string lower = to_lower_ascii(target);
  const bool is_autolink = lower.starts_with("http://")
    || lower.starts_with("https://")
    || lower.starts_with("mailto:");
  const bool is_email = target.find('@') != std::string_view::npos
    && target.find(' ') == std::string_view::npos
    && target.find(':') == std::string_view::npos;
  if (!is_autolink && !is_email) {
    return false;
  }
  end_offset = close + 1;
  return true;
}

bool match_footnote_ref(std::string_view text, std::size_t index, std::size_t& end_offset) {
  if (index + 1 >= text.size() || text[index] != '[' || text[index + 1] != '^') {
    return false;
  }
  const std::size_t label_end = text.find(']', index + 2);
  if (label_end == std::string_view::npos || label_end == index + 2) {
    return false;
  }
  end_offset = label_end + 1;
  return true;
}

bool match_bracket_destination(std::string_view text, std::size_t label_end, std::size_t& end_offset) {
  if (label_end + 1 >= text.size()) {
    return false;
  }
  if (text[label_end + 1] == '(') {
    const std::size_t url_end = text.find(')', label_end + 2);
    if (url_end == std::string_view::npos) {
      return false;
    }
    end_offset = url_end + 1;
    return true;
  }
  if (text[label_end + 1] == '[') {
    const std::size_t ref_end = text.find(']', label_end + 2);
    if (ref_end == std::string_view::npos) {
      return false;
    }
    end_offset = ref_end + 1;
    return true;
  }
  return false;
}

bool unclosed_bracket_destination(std::string_view text, std::size_t label_end) {
  return label_end + 1 < text.size()
    && text[label_end + 1] == '('
    && text.find(')', label_end + 2) == std::string_view::npos;
}

bool match_image(std::string_view text, std::size_t index, std::size_t& end_offset) {
  if (index + 1 >= text.size() || text[index] != '!' || text[index + 1] != '[') {
    return false;
  }
  const std::size_t label_end = text.find(']', index + 2);
  if (label_end == std::string_view::npos) {
    return false;
  }
  return match_bracket_destination(text, label_end, end_offset);
}

bool match_inline_link(std::string_view text, std::size_t index, std::size_t& end_offset) {
  if (index >= text.size() || text[index] != '[' || (index + 1 < text.size() && text[index + 1] == '^')) {
    return false;
  }
  const std::size_t label_end = text.find(']', index + 1);
  if (label_end == std::string_view::npos) {
    return false;
  }
  return match_bracket_destination(text, label_end, end_offset);
}

void scan_inline_syntax(
  std::string_view source,
  std::size_t start,
  std::size_t end,
  std::vector<syntax_node>& nodes
) {
  if (end > source.size()) {
    end = source.size();
  }
  if (start >= end) {
    return;
  }

  const std::string_view text = source.substr(start, end - start);
  std::size_t index = 0;
  while (index < text.size()) {
    const char ch = text[index];
    std::size_t next_index = index;

    if (skip_inline_latex(text, index, next_index)) {
      nodes.push_back({syntax_kind::latex, start + index, start + next_index});
      index = next_index;
      continue;
    }

    if (ch == '\\' && index + 1 < text.size()) {
      index += 2;
      continue;
    }

    if (ch == '`' && skip_inline_code_span(text, index, next_index)) {
      index = next_index;
      continue;
    }

    if (match_autolink(text, index, next_index)) {
      nodes.push_back({syntax_kind::link, start + index, start + next_index});
      index = next_index;
      continue;
    }

    if (match_footnote_ref(text, index, next_index)) {
      nodes.push_back({syntax_kind::footnote, start + index, start + next_index});
      index = next_index;
      continue;
    }

    if (ch == '[' && index + 1 < text.size() && text[index + 1] == '^') {
      nodes.push_back({syntax_kind::malformed, start + index, start + text.size()});
      break;
    }

    if (match_image(text, index, next_index)) {
      nodes.push_back({syntax_kind::image, start + index, start + next_index});
      index = next_index;
      continue;
    }

    if (ch == '!' && index + 1 < text.size() && text[index + 1] == '[') {
      const std::size_t label_end = text.find(']', index + 2);
      if (label_end == std::string_view::npos || unclosed_bracket_destination(text, label_end)) {
        nodes.push_back({syntax_kind::malformed, start + index, start + text.size()});
        break;
      }
    }

    if (match_inline_link(text, index, next_index)) {
      nodes.push_back({syntax_kind::link, start + index, start + next_index});
      index = next_index;
      continue;
    }

    if (ch == '[') {
      const std::size_t label_end = text.find(']', index + 1);
      if (label_end != std::string_view::npos && unclosed_bracket_destination(text, label_end)) {
        nodes.push_back({syntax_kind::malformed, start + index, start + text.size()});
        break;
      }
    }

    ++index;
  }
}

bool is_inline_bearing_kind(syntax_kind kind) {
  switch (kind) {
    case syntax_kind::heading:
    case syntax_kind::paragraph:
    case syntax_kind::list:
    case syntax_kind::task:
    case syntax_kind::quote:
    case syntax_kind::table:
    case syntax_kind::explicit_paragraph:
      return true;
    default:
      return false;
  }
}

void assign_syntax_parents(std::vector<syntax_node>& nodes) {
  std::vector<std::size_t> active;
  for (std::size_t index = 0; index < nodes.size(); ++index) {
    const syntax_node& child = nodes[index];
    // Sorted starts let us discard ranges that cannot contain this or later nodes.
    // Keep touching endpoints: a zero-width child can still have a strict parent.
    active.erase(std::remove_if(active.begin(), active.end(), [&](std::size_t candidate) {
      return nodes[candidate].end_offset < child.start_offset;
    }), active.end());
    std::size_t best = static_cast<std::size_t>(-1);
    std::size_t best_span = static_cast<std::size_t>(-1);
    for (const std::size_t candidate : active) {
      const syntax_node& parent = nodes[candidate];
      const bool contains =
        parent.start_offset <= child.start_offset &&
        parent.end_offset >= child.end_offset &&
        (parent.start_offset < child.start_offset || parent.end_offset > child.end_offset);
      if (!contains) {
        continue;
      }
      const std::size_t span = parent.end_offset - parent.start_offset;
      if (span < best_span) {
        best_span = span;
        best = candidate;
      }
    }
    nodes[index].parent_index = best;
    active.push_back(index);
  }
}

std::vector<syntax_node> collect_syntax_blocks_impl(
  std::string_view source,
  std::vector<anchor_owner_block>* additional_anchor_regions = nullptr
) {
  std::vector<SourceLine> raw_lines;
  std::size_t line_start = 0;
  while (line_start <= source.size()) {
    const std::size_t line_end = source.find('\n', line_start);
    if (line_end == std::string_view::npos) {
      raw_lines.push_back({source.substr(line_start), line_start, source.size()});
      break;
    }
    raw_lines.push_back({
      source.substr(line_start, line_end - line_start),
      line_start,
      line_end,
    });
    line_start = line_end + 1;
  }

  std::vector<syntax_node> nodes;
  std::vector<SourceLine> lines;
  lines.reserve(raw_lines.size());
  for (const auto& line : raw_lines) {
    if (is_footnote_definition_line(line.text)) {
      nodes.push_back({
        syntax_kind::footnote,
        line.start,
        exclusive_line_end(source, line),
      });
      continue;
    }
    if (is_reference_definition_line(line.text)) {
      continue;
    }
    lines.push_back(line);
  }
  std::size_t paragraph_start = 0;
  bool in_paragraph = false;
  std::size_t list_start = 0;
  std::size_t list_end = 0;
  bool in_list = false;
  std::size_t active_nested_list_depth = 0;
  bool list_is_task = false;
  bool in_code_block = false;
  std::size_t code_start = 0;
  char fence_char = '`';
  std::string_view fence_lang;
  bool in_latex_block = false;
  std::size_t latex_start = 0;

  auto flush_paragraph = [&](std::size_t end_offset) {
    if (!in_paragraph) {
      return;
    }
    nodes.push_back({syntax_kind::paragraph, paragraph_start, end_offset});
    in_paragraph = false;
  };

  auto flush_list = [&]() {
    if (!in_list) {
      return;
    }
    nodes.push_back({
      list_is_task ? syntax_kind::task : syntax_kind::list,
      list_start,
      list_end,
    });
    in_list = false;
    list_is_task = false;
    active_nested_list_depth = 0;
  };

  auto start_paragraph = [&](std::size_t start_offset) {
    if (!in_paragraph) {
      paragraph_start = start_offset;
      in_paragraph = true;
    }
  };

  auto append_list_item = [&](const SourceLine& line, bool task_item) {
    active_nested_list_depth = 0;
    if (!in_list) {
      list_start = line.start;
      list_is_task = task_item;
      in_list = true;
    } else if (task_item) {
      list_is_task = true;
    }
    list_end = exclusive_line_end(source, line);
  };

  for (std::size_t index = 0; index < lines.size(); ++index) {
    const SourceLine& line = lines[index];
    const std::string_view trimmed = trim(line.text);

    if (in_code_block) {
      if (parse_fence_end(line.text, fence_char)) {
        in_code_block = false;
        const syntax_kind kind = trim(fence_lang) == "mermaid"
          ? syntax_kind::mermaid
          : syntax_kind::code;
        nodes.push_back({kind, code_start, exclusive_line_end(source, line)});
      }
      continue;
    }

    if (in_latex_block) {
      if (trimmed == "$$") {
        in_latex_block = false;
        nodes.push_back({syntax_kind::latex, latex_start, exclusive_line_end(source, line)});
      }
      continue;
    }

    if (trimmed.empty()) {
      flush_paragraph(line.start);
      if (additional_anchor_regions && in_list) {
        std::size_t next = index + 1;
        while (next < lines.size() && trim(lines[next].text).empty()) {
          ++next;
        }
        if (next < lines.size() && continues_nested_list(lines[next].text)) {
          continue;
        }
      }
      flush_list();
      continue;
    }

    if (is_paragraph_group_start(line.text)) {
      flush_paragraph(line.start);
      flush_list();
      std::size_t group_index = index + 1;
      std::size_t depth = 1;
      while (group_index < lines.size()) {
        if (is_paragraph_group_start(lines[group_index].text)) {
          ++depth;
        } else if (is_paragraph_group_end(lines[group_index].text)) {
          --depth;
          if (depth == 0) {
            break;
          }
        }
        ++group_index;
      }
      if (group_index < lines.size() && depth == 0) {
        nodes.push_back({
          syntax_kind::explicit_paragraph,
          line.start,
          exclusive_line_end(source, lines[group_index]),
        });
        index = group_index;
        continue;
      }
      nodes.push_back({
        syntax_kind::malformed,
        line.start,
        source.size(),
        static_cast<std::size_t>(-1),
        {},
        {},
        syntax_status::malformed,
        "unclosed-explicit-paragraph",
      });
      index = lines.size();
      continue;
    }

    if (!trimmed.empty() && trimmed.front() == '>') {
      flush_paragraph(line.start);
      flush_list();
      std::size_t quote_index = index;
      char quoted_fence = '\0';
      std::size_t quoted_fence_start = index;
      while (quote_index < lines.size()) {
        const auto& quote_line = lines[quote_index];
        const std::string_view quote_trimmed = trim_left(quote_line.text);
        if (quote_trimmed.empty() || quote_trimmed.front() != '>') {
          break;
        }
        if (additional_anchor_regions) {
          const auto inner = strip_blockquote_prefix(quote_line.text, 0);
          if (quoted_fence != '\0') {
            if (parse_fence_end(inner.source, quoted_fence)) {
              quoted_fence = '\0';
            }
          } else {
            std::string_view language;
            if (parse_fence_start(inner.source, quoted_fence, language)) {
              quoted_fence_start = quote_index;
            }
          }
        }
        ++quote_index;
      }
      // A quote ending inside its child's code fence does not have an inline
      // anchor on its final line. The child renderer flushes the literal code.
      if (additional_anchor_regions && quoted_fence != '\0') {
        additional_anchor_regions->push_back({
          syntax_kind::code,
          {lines[quoted_fence_start].start, exclusive_line_end(source, lines[quote_index - 1])},
        });
      }
      if (quote_index > index) {
        nodes.push_back({
          syntax_kind::quote,
          line.start,
          exclusive_line_end(source, lines[quote_index - 1]),
        });
        index = quote_index - 1;
      }
      continue;
    }

    if (is_horizontal_rule(line.text)) {
      flush_paragraph(line.start);
      flush_list();
      continue;
    }

    if (index + 1 < lines.size()) {
      const int setext_level = parse_setext_heading_level(lines[index + 1].text);
      char setext_fence_char = '\0';
      std::string_view setext_fence_lang;
      if (
        setext_level > 0 &&
        !trimmed.empty() &&
        trimmed.front() != '>' &&
        !is_indented_code_line(line.text) &&
        !parse_fence_start(line.text, setext_fence_char, setext_fence_lang)
      ) {
        flush_paragraph(line.start);
        flush_list();
        nodes.push_back({
          syntax_kind::heading,
          line.start,
          exclusive_line_end(source, lines[index + 1]),
        });
        ++index;
        continue;
      }
    }

    if (trimmed.front() == '#' && is_atx_heading_line(line.text)) {
      flush_paragraph(line.start);
      flush_list();
      nodes.push_back({syntax_kind::heading, line.start, exclusive_line_end(source, line)});
      continue;
    }

    if (parse_fence_start(line.text, fence_char, fence_lang)) {
      flush_paragraph(line.start);
      flush_list();
      in_code_block = true;
      code_start = line.start;
      continue;
    }

    if (additional_anchor_regions && in_list && continues_nested_list(line.text)) {
      const std::size_t indent = line.text.size() - trim_left(line.text).size();
      const bool uses_spaces = line.text.substr(0, indent).find_first_not_of(' ') == std::string_view::npos;
      std::size_t depth = 0;
      std::size_t remaining = indent;
      // Every open ancestor list copies away exactly two columns. At the
      // first level without a list item, four residual spaces start code.
      // Keep levels in sync when a sibling replaces the current item.
      while (uses_spaces && depth <= active_nested_list_depth && remaining >= 2) {
        remaining -= 2;
        ++depth;
      }
      if (uses_spaces && remaining < 4) {
        active_nested_list_depth = depth;
      } else {
        // Do not strip a marker when this copied line cannot bind an item.
        additional_anchor_regions->push_back({
          syntax_kind::list, {line.start, exclusive_line_end(source, line)},
        });
        active_nested_list_depth = depth > 0 ? depth - 1 : 0;
      }
      list_end = exclusive_line_end(source, line);
      continue;
    }

    if (is_indented_code_line(line.text)) {
      flush_paragraph(line.start);
      flush_list();
      std::size_t code_index = index;
      while (code_index < lines.size()) {
        if (trim(lines[code_index].text).empty()) {
          ++code_index;
          continue;
        }
        if (!is_indented_code_line(lines[code_index].text)) {
          break;
        }
        ++code_index;
      }
      nodes.push_back({
        syntax_kind::code,
        line.start,
        exclusive_line_end(source, lines[code_index > index ? code_index - 1 : index]),
      });
      index = code_index > 0 ? code_index - 1 : index;
      continue;
    }

    if (line.text.starts_with("::embed[") || trim_left(line.text).starts_with("::embed[")) {
      flush_paragraph(line.start);
      flush_list();
      const bool looks_closed = line.text.starts_with("::embed[") &&
        line.text.find(']') != std::string_view::npos;
      nodes.push_back({
        looks_closed ? syntax_kind::embed : syntax_kind::malformed,
        line.start,
        exclusive_line_end(source, line),
      });
      continue;
    }

    if (trimmed.starts_with(":::mermaid")) {
      flush_paragraph(line.start);
      flush_list();
      std::size_t mermaid_index = index + 1;
      while (mermaid_index < lines.size() && trim(lines[mermaid_index].text) != ":::") {
        ++mermaid_index;
      }
      if (mermaid_index < lines.size()) {
        nodes.push_back({
          syntax_kind::mermaid,
          line.start,
          exclusive_line_end(source, lines[mermaid_index]),
        });
        index = mermaid_index;
      } else {
        nodes.push_back({
          syntax_kind::malformed,
          line.start,
          source.size(),
          static_cast<std::size_t>(-1),
          {},
          {},
          syntax_status::malformed,
          "unclosed-mermaid",
        });
        index = lines.size();
      }
      continue;
    }

    if (trimmed.starts_with("$$")) {
      flush_paragraph(line.start);
      flush_list();
      if (trimmed.size() > 4 && trimmed.ends_with("$$")) {
        nodes.push_back({syntax_kind::latex, line.start, exclusive_line_end(source, line)});
      } else {
        in_latex_block = true;
        latex_start = line.start;
      }
      continue;
    }

    if (index + 1 < lines.size() && trimmed.find('|') != std::string_view::npos) {
      std::vector<std::string_view> views;
      views.reserve(lines.size());
      for (const auto& item : lines) {
        views.push_back(item.text);
      }
      std::vector<table_alignment> alignments;
      const std::size_t separator = find_next_non_empty_line(views, index + 1);
      if (
        separator != std::string_view::npos &&
        parse_table_separator_row(trim(lines[separator].text), alignments) &&
        !split_table_cells(trimmed).empty()
      ) {
        flush_paragraph(line.start);
        flush_list();
        std::size_t cursor = separator + 1;
        while (cursor < lines.size()) {
          const auto row_index = find_next_table_body_row(views, cursor);
          if (row_index == std::string_view::npos) {
            break;
          }
          cursor = row_index + 1;
        }
        const std::size_t last_index = cursor > index ? cursor - 1 : index;
        nodes.push_back({
          syntax_kind::table,
          line.start,
          exclusive_line_end(source, lines[last_index]),
        });
        index = last_index;
        continue;
      }
    }

    std::string_view list_item;
    if (parse_unordered_list_item(line.text, list_item) || parse_ordered_list_item(line.text, list_item)) {
      flush_paragraph(line.start);
      bool checked = false;
      std::string_view task_content;
      append_list_item(line, parse_task_list_marker(list_item, checked, task_content));
      continue;
    }

    flush_list();
    start_paragraph(line.start);
  }

  if (in_code_block) {
    nodes.push_back({
      syntax_kind::malformed,
      code_start,
      source.size(),
      static_cast<std::size_t>(-1),
      {},
      {},
      syntax_status::malformed,
      trim(fence_lang) == "mermaid" ? "unclosed-mermaid" : "unclosed-code-fence",
    });
  }
  if (in_latex_block) {
    nodes.push_back({
      syntax_kind::malformed,
      latex_start,
      source.size(),
      static_cast<std::size_t>(-1),
      {},
      {},
      syntax_status::malformed,
      "unclosed-latex",
    });
  }
  flush_paragraph(source.size());
  flush_list();

  return nodes;
}

std::vector<syntax_node> collect_syntax_nodes_impl(std::string_view source) {
  auto nodes = collect_syntax_blocks_impl(source);
  const std::vector<syntax_node> blocks = nodes;
  for (const auto& block : blocks) {
    if (is_inline_bearing_kind(block.kind)) {
      scan_inline_syntax(source, block.start_offset, block.end_offset, nodes);
    }
  }

  std::sort(nodes.begin(), nodes.end(), [](const syntax_node& left, const syntax_node& right) {
    if (left.start_offset != right.start_offset) {
      return left.start_offset < right.start_offset;
    }
    if (left.end_offset != right.end_offset) {
      return left.end_offset > right.end_offset;
    }
    return static_cast<int>(left.kind) < static_cast<int>(right.kind);
  });

  assign_syntax_parents(nodes);
  for (auto& node : nodes) {
    if (node.kind == syntax_kind::malformed) {
      node.status = syntax_status::malformed;
      if (node.diagnostic_code.empty()) {
        node.diagnostic_code = "malformed-syntax";
      }
    }
    decorate_block_syntax(source, node);
  }
  return nodes;
}

} // namespace

std::string normalize_source(std::string_view input) {
  std::string normalized;
  normalized.reserve(input.size());

  for (const char ch : input) {
    if (ch == '\r') {
      continue;
    }
    normalized.push_back(ch);
  }

  if (normalized.size() >= 3 &&
      static_cast<unsigned char>(normalized[0]) == 0xEF &&
      static_cast<unsigned char>(normalized[1]) == 0xBB &&
      static_cast<unsigned char>(normalized[2]) == 0xBF) {
    normalized.erase(0, 3);
  }

  return normalized;
}

std::string escape_html(std::string_view input) {
  std::string escaped;
  escaped.reserve(input.size() + (input.size() / 4));

  for (const char ch : input) {
    switch (ch) {
      case '&':
        escaped.append("&amp;");
        break;
      case '<':
        escaped.append("&lt;");
        break;
      case '>':
        escaped.append("&gt;");
        break;
      case '"':
        escaped.append("&quot;");
        break;
      case '\'':
        escaped.append("&#39;");
        break;
      default:
        escaped.push_back(ch);
        break;
    }
  }

  return escaped;
}

bool contains_feature(std::string_view source, feature kind) {
  switch (kind) {
    case feature::code_block:
      return source.find("```") != std::string_view::npos || source.find("~~~") != std::string_view::npos;
    case feature::latex:
      return source.find("$$") != std::string_view::npos || source.find("\\(") != std::string_view::npos || source.find("\\[") != std::string_view::npos;
    case feature::mermaid:
      return source.find("```mermaid") != std::string_view::npos || source.find(":::mermaid") != std::string_view::npos;
    case feature::table:
      return source.find('|') != std::string_view::npos && source.find('-') != std::string_view::npos && source.find('\n') != std::string_view::npos;
    case feature::image:
      return source.find("![") != std::string_view::npos;
    case feature::heading:
      return source.find('#') != std::string_view::npos;
    case feature::link:
      return source.find('[') != std::string_view::npos && source.find("](") != std::string_view::npos;
    case feature::emphasis: {
      std::vector<std::string> dummy_refs;
      std::vector<reference_def> dummy_reference_defs;
      for (std::size_t index = 0; index < source.size(); ++index) {
        if (source[index] != '*' && source[index] != '_') {
          continue;
        }

        std::size_t next_index = index;
        std::string scratch;
        if (try_render_emphasis_v2(source, index, render_request{}, dummy_refs, dummy_reference_defs, scratch, next_index)) {
          return true;
        }
      }
      return false;
    }
    case feature::footnote:
      return source.find("[^") != std::string_view::npos;
  }

  return false;
}

std::vector<placeholder> collect_placeholders(std::string_view source) {
  std::vector<placeholder> placeholders;
  std::size_t line_no = 1;
  std::size_t line_start = 0;

  while (line_start <= source.size()) {
    const std::size_t line_end = source.find('\n', line_start);
    const std::string_view line = line_end == std::string_view::npos
      ? source.substr(line_start)
      : source.substr(line_start, line_end - line_start);
    const std::string_view trimmed = trim_left(line);
    const std::size_t column = line.size() - trimmed.size() + 1;

    if (trimmed.starts_with("```mermaid") || trimmed.starts_with(":::mermaid")) {
      std::size_t block_end_line = line_no;
      std::size_t block_end_offset = line_end == std::string_view::npos ? source.size() : line_end;
      std::string mermaid_source;
      mermaid_source.reserve(128);

      std::size_t scan_line_no = line_no + 1;
      std::size_t scan_index = line_end == std::string_view::npos ? source.size() : line_end + 1;
      while (scan_index <= source.size()) {
        const std::size_t next_end = source.find('\n', scan_index);
        const std::string_view next_line = next_end == std::string_view::npos
          ? source.substr(scan_index)
          : source.substr(scan_index, next_end - scan_index);
        const std::string_view next_trimmed = trim_left(next_line);
        if (next_trimmed == ":::" || next_trimmed.starts_with("```")) {
          block_end_line = scan_line_no;
          block_end_offset = next_end == std::string_view::npos ? source.size() : next_end;
          break;
        }

        mermaid_source.append(next_line.data(), next_line.size());
        if (next_end == std::string_view::npos) {
          block_end_line = scan_line_no;
          block_end_offset = source.size();
          break;
        }
        mermaid_source.push_back('\n');
        scan_index = next_end + 1;
        ++scan_line_no;
        block_end_line = scan_line_no;
        block_end_offset = next_end;
      }

      placeholders.push_back({
        placeholder_kind::mermaid_block,
        "mermaid",
        "Mermaid 图表将在 Wasm 渲染器中占位",
        std::move(mermaid_source),
        line_no,
        column,
        block_end_line,
        1,
        line_start,
        block_end_offset
      });
    } else if (trimmed == "$$" || trimmed.starts_with("$$ ")) {
      std::size_t block_end_line = line_no;
      std::size_t block_end_offset = line_end == std::string_view::npos ? source.size() : line_end;
      std::string latex_source;
      latex_source.reserve(128);

      std::size_t scan_line_no = line_no + 1;
      std::size_t scan_index = line_end == std::string_view::npos ? source.size() : line_end + 1;
      while (scan_index <= source.size()) {
        const std::size_t next_end = source.find('\n', scan_index);
        const std::string_view next_line = next_end == std::string_view::npos
          ? source.substr(scan_index)
          : source.substr(scan_index, next_end - scan_index);
        const std::string_view next_trimmed = trim_left(next_line);
        if (next_trimmed == "$$" || next_trimmed.starts_with("$$ ")) {
          block_end_line = scan_line_no;
          block_end_offset = next_end == std::string_view::npos ? source.size() : next_end;
          break;
        }

        latex_source.append(next_line.data(), next_line.size());
        if (next_end == std::string_view::npos) {
          block_end_line = scan_line_no;
          block_end_offset = source.size();
          break;
        }
        latex_source.push_back('\n');
        scan_index = next_end + 1;
        ++scan_line_no;
        block_end_line = scan_line_no;
        block_end_offset = next_end;
      }

      placeholders.push_back({
        placeholder_kind::latex_block,
        "latex-block",
        "LaTeX 块公式将在 Wasm 渲染器中占位",
        std::move(latex_source),
        line_no,
        column,
        block_end_line,
        1,
        line_start,
        block_end_offset
      });
    } else if (line.find("\\(") != std::string_view::npos || line.find("\\[") != std::string_view::npos) {
      const std::string_view token = line.find("\\(") != std::string_view::npos ? "\\(" : "\\[";
      const std::size_t token_column = find_token_column(line, token);
      const std::size_t token_offset = token_column == 0 ? line_start : line_start + token_column - 1;
      placeholders.push_back({
        placeholder_kind::latex_inline,
        "latex-inline",
        "LaTeX 行内公式将在 Wasm 渲染器中占位",
        std::string(line),
        line_no,
        token_column,
        line_no,
        token_column + token.size(),
        token_offset,
        token_offset + token.size()
      });
    }

    if (line_end == std::string_view::npos) {
      break;
    }

    line_start = line_end + 1;
    ++line_no;
  }

  return placeholders;
}

std::string_view syntax_kind_name(syntax_kind kind) {
  switch (kind) {
    case syntax_kind::heading: return "heading";
    case syntax_kind::paragraph: return "paragraph";
    case syntax_kind::list: return "list";
    case syntax_kind::task: return "task";
    case syntax_kind::quote: return "quote";
    case syntax_kind::table: return "table";
    case syntax_kind::link: return "link";
    case syntax_kind::image: return "image";
    case syntax_kind::code: return "code";
    case syntax_kind::latex: return "latex";
    case syntax_kind::mermaid: return "mermaid";
    case syntax_kind::footnote: return "footnote";
    case syntax_kind::explicit_paragraph: return "explicit-paragraph";
    case syntax_kind::embed: return "embed";
    case syntax_kind::caption: return "caption";
    case syntax_kind::anchor: return "anchor";
    case syntax_kind::malformed: return "malformed";
    case syntax_kind::count: break;
  }
  return "malformed";
}

std::vector<anchor_owner_block> collect_anchor_owner_blocks(std::string_view source) {
  std::vector<anchor_owner_block> owners;
  for (const auto& block : collect_syntax_blocks_impl(source, &owners)) {
    if (block.status == syntax_status::valid &&
        (block.kind == syntax_kind::paragraph || block.kind == syntax_kind::code ||
         block.kind == syntax_kind::table || block.kind == syntax_kind::quote)) {
      owners.push_back({ block.kind, { block.start_offset, block.end_offset } });
    }
  }
  std::sort(owners.begin(), owners.end(), [](const auto& a, const auto& b) {
    return a.range.start_offset < b.range.start_offset;
  });
  return owners;
}

std::vector<syntax_node> collect_syntax_nodes(std::string_view source) {
  return collect_syntax_nodes_impl(source);
}

std::size_t count_placeholders(std::string_view source) {
  std::size_t placeholder_count = 0;
  std::size_t line_start = 0;

  while (line_start <= source.size()) {
    const std::size_t line_end = source.find('\n', line_start);
    const std::string_view line = line_end == std::string_view::npos
      ? source.substr(line_start)
      : source.substr(line_start, line_end - line_start);
    const std::string_view trimmed = trim_left(line);

    if (
      trimmed.starts_with("```mermaid") ||
      trimmed.starts_with(":::mermaid") ||
      trimmed == "$$" ||
      trimmed.starts_with("$$ ") ||
      line.find("\\(") != std::string_view::npos ||
      line.find("\\[") != std::string_view::npos
    ) {
      ++placeholder_count;
    }

    if (line_end == std::string_view::npos) {
      break;
    }

    line_start = line_end + 1;
  }

  return placeholder_count;
}

void fill_feature_metadata(render_result& result, const render_request& request, std::string_view normalized) {
  result.features.reserve(9);

  for (feature kind : {feature::code_block, feature::latex, feature::mermaid, feature::table, feature::image, feature::heading, feature::link, feature::emphasis, feature::footnote}) {
    if (contains_feature(normalized, kind)) {
      result.features.push_back(kind);
    }
  }

  result.metadata.mode = request.mode;
  result.metadata.base_url = request.base_url;
  result.metadata.allow_latex = request.allow_latex;
  result.metadata.allow_mermaid = request.allow_mermaid;
  result.metadata.source_length = request.source.size();
  result.metadata.source_line_count = count_lines(normalized);
  result.metadata.normalized_source_length = normalized.size();
  result.metadata.feature_count = result.features.size();
  result.metadata.renderer_version = std::string(renderer_version);
}

render_result build_summary_result(const render_request& request) {
  const std::string normalized = normalize_source(request.source);
  render_result result;
  result.normalized_source = normalized;
  fill_feature_metadata(result, request, normalized);
  result.metadata.placeholder_count = count_placeholders(normalized);
  result.html = render_document(normalized, request);
  return result;
}

render_result build_render_result(const render_request& request) {
  const std::string normalized = normalize_source(request.source);
  render_result result;
  result.normalized_source = normalized;
  fill_feature_metadata(result, request, normalized);

  result.placeholders = collect_placeholders(normalized);
  result.syntax_nodes = collect_syntax_nodes(normalized);
  result.metadata.placeholder_count = result.placeholders.size();
  result.html = render_document(normalized, request);
  return result;
}

render_result build_placeholder_result(const render_request& request) {
  return build_render_result(request);
}

std::string render_html(const render_request& request) {
  const std::string normalized = normalize_source(request.source);
  return render_document(normalized, request);
}

} // namespace fsusblog::wasm::markdown
