#include "markdown_contract.hpp"
#include "markdown_latex.hpp"
#include "markdown_mermaid.hpp"

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>
#include <vector>

namespace fsusblog::wasm::markdown {
namespace {

constexpr std::string_view kCodeClass = "shiki";

enum class table_alignment {
  none,
  left,
  center,
  right
};

std::string render_document(std::string_view source, const render_request& request);

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

bool is_safe_url(std::string_view input) {
  const std::string_view url = trim(input);
  if (url.empty()) {
    return false;
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
  if (base.empty()) {
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

std::string render_inline(std::string_view text, const render_request& request);

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

bool try_render_emphasis(
  std::string_view text,
  std::size_t index,
  const render_request& request,
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

    const std::string rendered_inner = render_inline(inner, request);
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

std::string render_inline(std::string_view text, const render_request& request) {
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
      out.push_back(text[index + 1]);
      index += 2;
      segment_start = index;
      continue;
    }

    if (ch == '`') {
      const std::size_t close = text.find('`', index + 1);
      if (close != std::string_view::npos) {
        flush_segment(index);
        out.append("<code>");
        out.append(escape_html(text.substr(index + 1, close - index - 1)));
        out.append("</code>");
        index = close + 1;
        segment_start = index;
        continue;
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
    }

    if (ch == '*' || ch == '_') {
      std::string emphasis_html;
      std::size_t next_index = index;
      if (try_render_emphasis(text, index, request, emphasis_html, next_index)) {
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

std::string render_heading(std::string_view line, const render_request& request) {
  const std::string_view trimmed = trim_left(line);
  std::size_t level = 0;
  while (level < trimmed.size() && trimmed[level] == '#') {
    ++level;
  }
  if (level == 0 || level > 6 || level >= trimmed.size() || trimmed[level] != ' ') {
    return {};
  }

  const std::string_view content = trim_left(trimmed.substr(level + 1));
  std::string out;
  out.reserve(content.size() + 32);
  out.append("<h");
  out.push_back(static_cast<char>('0' + level));
  out.append(">");
  out.append(render_inline(content, request));
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
  if (trimmed.size() < 3) {
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

std::string render_list(const std::vector<std::string>& items, bool ordered, const render_request& request) {
  if (items.empty()) {
    return {};
  }

  std::string out;
  out.reserve(128 + items.size() * 64);
  out.append(ordered ? "<ol>" : "<ul>");
  for (const auto& item : items) {
    out.append("<li>");
    out.append(render_inline(item, request));
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

std::string_view strip_blockquote_prefix(std::string_view line) {
  const std::string_view trimmed = trim_left(line);
  if (trimmed.empty() || trimmed.front() != '>') {
    return {};
  }

  std::size_t index = 0;
  while (index < trimmed.size() && trimmed[index] == '>') {
    ++index;
    while (index < trimmed.size() && trimmed[index] == ' ') {
      ++index;
    }
  }

  return trim_left(trimmed.substr(index));
}

std::vector<std::string> split_table_cells(std::string_view row) {
  std::vector<std::string> cells;
  std::string cell;
  const std::size_t begin = row.starts_with('|') ? 1 : 0;
  const std::size_t end = row.size() > begin && row.back() == '|' ? row.size() - 1 : row.size();

  bool escaped = false;
  for (std::size_t index = begin; index < end; ++index) {
    const char ch = row[index];
    if (escaped) {
      cell.push_back(ch);
      escaped = false;
      continue;
    }

    if (ch == '\\') {
      escaped = true;
      continue;
    }

    if (ch == '|') {
      cells.emplace_back(trim(cell));
      cell.clear();
      continue;
    }

    cell.push_back(ch);
  }

  cells.emplace_back(trim(cell));
  return cells;
}

bool parse_table_separator_cell(std::string_view cell, table_alignment& alignment) {
  const std::string_view trimmed = trim(cell);
  if (trimmed.size() < 3) {
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

  if (hyphen_count < 3) {
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

std::string render_table_row(const std::vector<std::string>& cells, bool header, const std::vector<table_alignment>& alignments, const render_request& request) {
  std::string out;
  out.append("<tr>");

  const std::size_t column_count = std::max(cells.size(), alignments.size());
  for (std::size_t index = 0; index < column_count; ++index) {
    const bool has_cell = index < cells.size();
    const std::string_view cell = has_cell ? cells[index] : std::string_view{};
    const table_alignment alignment = index < alignments.size() ? alignments[index] : table_alignment::none;
    out.append(header ? "<th" : "<td");
    out.append(table_alignment_attribute(alignment));
    out.append(">");
    if (has_cell) {
      out.append(render_inline(cell, request));
    }
    out.append(header ? "</th>" : "</td>");
  }

  out.append("</tr>");
  return out;
}

std::string render_table_block(const std::vector<std::string_view>& lines, std::size_t& index, const render_request& request) {
  if (index + 1 >= lines.size()) {
    return {};
  }

  const std::string_view header_row = lines[index];
  const std::string_view separator_row = lines[index + 1];

  std::vector<table_alignment> alignments;
  if (!parse_table_separator_row(separator_row, alignments)) {
    return {};
  }

  const std::vector<std::string> header_cells = split_table_cells(header_row);
  if (header_cells.empty()) {
    return {};
  }

  std::string html;
  html.append("<table><thead>");
  html.append(render_table_row(header_cells, true, alignments, request));
  html.append("</thead><tbody>");

  index += 2;
  while (index < lines.size()) {
    const std::string_view row = trim(lines[index]);
    if (row.empty() || row.find('|') == std::string_view::npos || parse_table_separator_row(row, alignments)) {
      break;
    }

    html.append(render_table_row(split_table_cells(row), false, alignments, request));
    ++index;
  }

  html.append("</tbody></table>");
  --index;
  return html;
}

std::string render_blockquote(const std::vector<std::string_view>& lines, std::size_t& index, const render_request& request) {
  std::string inner;
  bool first_line = true;

  while (index < lines.size()) {
    const std::string_view raw_line = lines[index];
    const std::string_view trimmed = trim_left(raw_line);
    if (trimmed.empty() || trimmed.front() != '>') {
      break;
    }

    const std::string_view content = strip_blockquote_prefix(raw_line);
    if (!first_line) {
      inner.push_back('\n');
    }
    inner.append(content.data(), content.size());
    first_line = false;
    ++index;
  }

  if (inner.empty()) {
    return {};
  }

  return "<blockquote>" + render_document(inner, request) + "</blockquote>";
}

std::string render_document(std::string_view source, const render_request& request) {
  if (source.empty()) {
    return {};
  }

  std::vector<std::string_view> lines;
  lines.reserve(64);
  std::size_t line_start = 0;
  while (line_start <= source.size()) {
    const std::size_t line_end = source.find('\n', line_start);
    lines.emplace_back(line_end == std::string_view::npos
      ? source.substr(line_start)
      : source.substr(line_start, line_end - line_start));
    if (line_end == std::string_view::npos) {
      break;
    }
    line_start = line_end + 1;
  }

  std::string html;
  html.reserve(source.size() + 256);

  std::string paragraph;
  std::vector<std::string> list_items;
  bool list_ordered = false;
  bool in_code_block = false;
  bool in_latex_block = false;
  char fence_char = '`';
  std::string_view fence_lang;
  std::string code_buffer;
  std::string latex_buffer;

  auto flush_paragraph = [&]() {
    const std::string_view trimmed = trim(paragraph);
    if (!trimmed.empty()) {
      html.append("<p>");
      html.append(render_inline(trimmed, request));
      html.append("</p>");
    }
    paragraph.clear();
  };

  auto flush_list = [&]() {
    if (list_items.empty()) {
      return;
    }
    html.append(render_list(list_items, list_ordered, request));
    list_items.clear();
  };

  auto flush_code = [&]() {
    if (code_buffer.empty()) {
      return;
    }

    const std::string_view language = trim(fence_lang);
    const std::string_view code_view = code_buffer;
    const bool is_mermaid = language == "mermaid";
    if (is_mermaid && request.allow_mermaid) {
      html.append(mermaid::render_block(code_view));
    } else {
      html.append(escape_and_wrap_code(code_view, language));
    }
    code_buffer.clear();
    fence_lang = {};
  };

  auto flush_latex = [&]() {
    if (latex_buffer.empty()) {
      return;
    }

    if (request.allow_latex) {
      html.append(latex::render_fragment({
        latex_buffer,
        latex::fragment_kind::block_math
      }));
    } else {
      html.append(escape_and_wrap_code(latex_buffer, "latex"));
    }
    latex_buffer.clear();
  };

  for (std::size_t index = 0; index < lines.size(); ++index) {
    const std::string_view line = lines[index];
    const std::string_view trimmed = trim(line);

    if (in_code_block) {
      if (parse_fence_end(line, fence_char)) {
        in_code_block = false;
        flush_code();
      } else {
        code_buffer.append(line.data(), line.size());
        code_buffer.push_back('\n');
      }
      continue;
    }

    if (in_latex_block) {
      if (trimmed == "$$") {
        in_latex_block = false;
        flush_latex();
      } else {
        latex_buffer.append(line.data(), line.size());
        latex_buffer.push_back('\n');
      }
      continue;
    }

    if (trimmed.empty()) {
      flush_paragraph();
      flush_list();
      continue;
    }

    if (request.allow_html && trimmed.starts_with('<') && trimmed.find('>') != std::string_view::npos) {
      flush_paragraph();
      flush_list();
      html.append(line.data(), line.size());
      continue;
    }

    if (trimmed.front() == '>') {
      flush_paragraph();
      flush_list();
      std::size_t quote_index = index;
      const std::string quote_html = render_blockquote(lines, quote_index, request);
      if (!quote_html.empty()) {
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

    if (trimmed.front() == '#') {
      const std::string heading_html = render_heading(line, request);
      if (!heading_html.empty()) {
        flush_paragraph();
        flush_list();
        html.append(heading_html);
      } else {
        if (!paragraph.empty()) {
          paragraph.push_back(' ');
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

      if (request.allow_mermaid) {
        html.append(mermaid::render_block(mermaid_buffer));
      } else {
        html.append(escape_and_wrap_code(mermaid_buffer, "mermaid"));
      }

      index = mermaid_index;
      continue;
    }

    if (trimmed.starts_with("$$")) {
      flush_paragraph();
      flush_list();
      if (trimmed.size() > 4 && trimmed.ends_with("$$")) {
        if (request.allow_latex) {
          html.append(latex::render_fragment({
            trimmed.substr(2, trimmed.size() - 4),
            latex::fragment_kind::block_math
          }));
        } else {
          html.append(escape_and_wrap_code(trimmed.substr(2, trimmed.size() - 4), "latex"));
        }
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
      const std::string table_html = render_table_block(lines, table_index, request);
      if (!table_html.empty()) {
        html.append(table_html);
        index = table_index;
        continue;
      }
    }

    std::string_view list_item;
    if (parse_unordered_list_item(line, list_item)) {
      flush_paragraph();
      if (!list_items.empty() && list_ordered) {
        html.append(render_list(list_items, list_ordered, request));
        list_items.clear();
      }
      list_ordered = false;
      list_items.emplace_back(list_item);
      continue;
    }

    if (parse_ordered_list_item(line, list_item)) {
      flush_paragraph();
      if (!list_items.empty() && !list_ordered) {
        html.append(render_list(list_items, list_ordered, request));
        list_items.clear();
      }
      list_ordered = true;
      list_items.emplace_back(list_item);
      continue;
    }

    flush_list();
    if (!paragraph.empty()) {
      paragraph.push_back(' ');
    }
    paragraph.append(trimmed.data(), trimmed.size());
  }

  if (in_code_block) {
    flush_code();
  }
  if (in_latex_block) {
    flush_latex();
  }
  flush_paragraph();
  flush_list();

  return html;
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
      for (std::size_t index = 0; index < source.size(); ++index) {
        if (source[index] != '*' && source[index] != '_') {
          continue;
        }

        std::size_t next_index = index;
        std::string scratch;
        if (try_render_emphasis(source, index, render_request{}, scratch, next_index)) {
          return true;
        }
      }
      return false;
    }
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

render_result build_render_result(const render_request& request) {
  const std::string normalized = normalize_source(request.source);
  render_result result;
  result.normalized_source = normalized;
  result.features.reserve(8);

  for (feature kind : {feature::code_block, feature::latex, feature::mermaid, feature::table, feature::image, feature::heading, feature::link, feature::emphasis}) {
    if (contains_feature(normalized, kind)) {
      result.features.push_back(kind);
    }
  }

  result.placeholders = collect_placeholders(normalized);
  result.metadata.mode = request.mode;
  result.metadata.base_url = request.base_url;
  result.metadata.allow_html = request.allow_html;
  result.metadata.allow_latex = request.allow_latex;
  result.metadata.allow_mermaid = request.allow_mermaid;
  result.metadata.source_length = request.source.size();
  result.metadata.source_line_count = count_lines(normalized);
  result.metadata.normalized_source_length = normalized.size();
  result.metadata.feature_count = result.features.size();
  result.metadata.placeholder_count = result.placeholders.size();
  result.metadata.renderer_version = std::string(renderer_version);
  result.html = render_document(normalized, request);
  return result;
}

render_result build_placeholder_result(const render_request& request) {
  return build_render_result(request);
}

std::string render_html(const render_request& request) {
  return build_render_result(request).html;
}

} // namespace fsusblog::wasm::markdown
