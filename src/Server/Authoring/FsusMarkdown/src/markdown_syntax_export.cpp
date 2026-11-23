#include "markdown_contract.hpp"

#include <cstdlib>
#include <string>
#include <vector>

namespace {

std::string g_syntax_json;
std::string g_syntax_kinds_json;

void append_json_string(std::string& out, std::string_view value) {
  out.push_back('"');
  for (const char ch : value) {
    if (ch == '"' || ch == '\\') {
      out.push_back('\\');
    }
    out.push_back(ch);
  }
  out.push_back('"');
}

void append_json_ranges(
  std::string& out,
  const std::vector<fsusblog::wasm::markdown::syntax_range>& ranges
) {
  out.push_back('[');
  bool first = true;
  for (const auto& range : ranges) {
    if (!first) {
      out.push_back(',');
    }
    first = false;
    out.append("{\"start\":");
    out.append(std::to_string(range.start_offset));
    out.append(",\"end\":");
    out.append(std::to_string(range.end_offset));
    out.push_back('}');
  }
  out.push_back(']');
}

std::string_view table_alignment_name(
  fsusblog::wasm::markdown::syntax_table_alignment alignment
) {
  using fsusblog::wasm::markdown::syntax_table_alignment;
  switch (alignment) {
    case syntax_table_alignment::left:
      return "left";
    case syntax_table_alignment::center:
      return "center";
    case syntax_table_alignment::right:
      return "right";
    case syntax_table_alignment::none:
      return "none";
  }
  return "none";
}

} // namespace

extern "C" {

void* markdown_syntax_alloc(int size) {
  return std::malloc(static_cast<std::size_t>(size));
}

void markdown_syntax_free(void* pointer) {
  std::free(pointer);
}

int markdown_syntax_collect(const char* source_ptr, int source_len) {
  if (source_ptr == nullptr || source_len < 0) {
    g_syntax_json = "[]";
    return 0;
  }

  const std::string source(source_ptr, source_ptr + source_len);
  const std::string normalized = fsusblog::wasm::markdown::normalize_source(source);
  const auto nodes = fsusblog::wasm::markdown::collect_syntax_nodes(normalized);
  std::vector<std::vector<std::size_t>> children(nodes.size());
  for (std::size_t index = 0; index < nodes.size(); ++index) {
    const std::size_t parent = nodes[index].parent_index;
    if (parent < nodes.size()) {
      children[parent].push_back(index);
    }
  }

  g_syntax_json.clear();
  g_syntax_json.push_back('[');
  bool first = true;
  for (std::size_t index = 0; index < nodes.size(); ++index) {
    const auto& node = nodes[index];
    if (!first) {
      g_syntax_json.push_back(',');
    }
    first = false;
    g_syntax_json.append("{\"kind\":");
    append_json_string(g_syntax_json, fsusblog::wasm::markdown::syntax_kind_name(node.kind));
    g_syntax_json.append(",\"start\":");
    g_syntax_json.append(std::to_string(node.start_offset));
    g_syntax_json.append(",\"end\":");
    g_syntax_json.append(std::to_string(node.end_offset));
    g_syntax_json.append(",\"status\":");
    append_json_string(
      g_syntax_json,
      node.status == fsusblog::wasm::markdown::syntax_status::malformed
        ? "malformed"
        : "valid"
    );
    g_syntax_json.append(",\"diagnosticCode\":");
    if (node.diagnostic_code.empty()) {
      g_syntax_json.append("null");
    } else {
      append_json_string(g_syntax_json, node.diagnostic_code);
    }
    g_syntax_json.append(",\"contentRanges\":");
    append_json_ranges(g_syntax_json, node.content_ranges);
    g_syntax_json.append(",\"markerRanges\":");
    append_json_ranges(g_syntax_json, node.marker_ranges);
    if (!node.table_row_ranges.empty()) {
      g_syntax_json.append(",\"tableRows\":[");
      for (
        std::size_t row_index = 0;
        row_index < node.table_row_ranges.size();
        ++row_index
      ) {
        if (row_index > 0) {
          g_syntax_json.push_back(',');
        }
        const auto& row = node.table_row_ranges[row_index];
        g_syntax_json.append("{\"start\":");
        g_syntax_json.append(std::to_string(row.start_offset));
        g_syntax_json.append(",\"end\":");
        g_syntax_json.append(std::to_string(row.end_offset));
        g_syntax_json.append(",\"cells\":");
        append_json_ranges(g_syntax_json, node.table_cell_ranges[row_index]);
        g_syntax_json.push_back('}');
      }
      g_syntax_json.push_back(']');
      g_syntax_json.append(",\"tableSeparatorRow\":");
      g_syntax_json.append(std::to_string(node.table_separator_row));
      g_syntax_json.append(",\"tableAlignments\":[");
      for (
        std::size_t alignment_index = 0;
        alignment_index < node.table_alignments.size();
        ++alignment_index
      ) {
        if (alignment_index > 0) {
          g_syntax_json.push_back(',');
        }
        append_json_string(
          g_syntax_json,
          table_alignment_name(node.table_alignments[alignment_index])
        );
      }
      g_syntax_json.push_back(']');
    }
    if (node.parent_index < nodes.size()) {
      const auto& parent = nodes[node.parent_index];
      g_syntax_json.append(",\"parentStart\":");
      g_syntax_json.append(std::to_string(parent.start_offset));
      g_syntax_json.append(",\"parentEnd\":");
      g_syntax_json.append(std::to_string(parent.end_offset));
    }
    g_syntax_json.append(",\"children\":[");
    bool first_child = true;
    for (const std::size_t child_index : children[index]) {
      if (!first_child) {
        g_syntax_json.push_back(',');
      }
      first_child = false;
      const auto& child = nodes[child_index];
      g_syntax_json.append("{\"start\":");
      g_syntax_json.append(std::to_string(child.start_offset));
      g_syntax_json.append(",\"end\":");
      g_syntax_json.append(std::to_string(child.end_offset));
      g_syntax_json.push_back('}');
    }
    g_syntax_json.push_back(']');
    g_syntax_json.push_back('}');
  }
  g_syntax_json.push_back(']');
  return 1;
}

const char* markdown_syntax_kinds_json_ptr() {
  if (g_syntax_kinds_json.empty()) {
    g_syntax_kinds_json.push_back('[');
    for (
      std::uint8_t value = 0;
      value < static_cast<std::uint8_t>(fsusblog::wasm::markdown::syntax_kind::count);
      ++value
    ) {
      if (value > 0) {
        g_syntax_kinds_json.push_back(',');
      }
      append_json_string(
        g_syntax_kinds_json,
        fsusblog::wasm::markdown::syntax_kind_name(
          static_cast<fsusblog::wasm::markdown::syntax_kind>(value)
        )
      );
    }
    g_syntax_kinds_json.push_back(']');
  }
  return g_syntax_kinds_json.c_str();
}

int markdown_syntax_kinds_json_len() {
  markdown_syntax_kinds_json_ptr();
  return static_cast<int>(g_syntax_kinds_json.size());
}

const char* markdown_syntax_json_ptr() {
  return g_syntax_json.c_str();
}

int markdown_syntax_json_len() {
  return static_cast<int>(g_syntax_json.size());
}

}
