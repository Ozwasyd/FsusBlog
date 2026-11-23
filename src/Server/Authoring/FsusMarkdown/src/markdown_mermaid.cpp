#include "markdown_mermaid.hpp"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace fsusblog::wasm::markdown::mermaid {
namespace {

constexpr std::string_view kMermaidPlaceholderClass = "markdown-renderer__mermaid";
constexpr std::string_view kPlaceholderTitleClass = "markdown-renderer__placeholder-title";
constexpr std::string_view kCodeClass = "shiki";
constexpr std::string_view kRenderedMarker = "data-mermaid-rendered=\"true\"";

struct node_spec final {
  std::string key;
  std::string label;
  bool has_explicit_label{ false };
};

struct edge_spec final {
  std::string from_key;
  std::string to_key;
};

struct node_layout final {
  int x{ 0 };
  int y{ 0 };
  int width{ 0 };
  int height{ 0 };
  int center_x{ 0 };
  int center_y{ 0 };
};

enum class graph_direction : std::uint8_t {
  top_down = 0,
  left_right = 1
};

struct graph_spec final {
  graph_direction direction{ graph_direction::top_down };
  std::vector<node_spec> nodes;
  std::vector<edge_spec> edges;
};

[[nodiscard]] std::string escape_html(std::string_view input) {
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

[[nodiscard]] std::string trim_copy(std::string_view input) {
  std::size_t start = 0;
  while (start < input.size() && std::isspace(static_cast<unsigned char>(input[start])) != 0) {
    ++start;
  }

  std::size_t end = input.size();
  while (end > start && std::isspace(static_cast<unsigned char>(input[end - 1])) != 0) {
    --end;
  }

  return std::string(input.substr(start, end - start));
}

[[nodiscard]] std::string escape_and_wrap_code(std::string_view code, std::string_view language) {
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

[[nodiscard]] std::string render_placeholder(std::string_view source) {
  std::string out;
  out.reserve(source.size() + 192);
  out.append("<figure class=\"");
  out.append(kMermaidPlaceholderClass);
  out.append("\" data-mermaid-placeholder=\"true\">");
  out.append("<figcaption class=\"");
  out.append(kPlaceholderTitleClass);
  out.append("\">Mermaid 图表将在交互层激活</figcaption>");
  out.append(escape_and_wrap_code(source, "mermaid"));
  out.append("</figure>");
  return out;
}

[[nodiscard]] bool starts_with_case_insensitive(std::string_view input, std::string_view prefix) {
  if (input.size() < prefix.size()) {
    return false;
  }

  for (std::size_t index = 0; index < prefix.size(); ++index) {
    if (std::tolower(static_cast<unsigned char>(input[index])) != std::tolower(static_cast<unsigned char>(prefix[index]))) {
      return false;
    }
  }

  return true;
}

[[nodiscard]] std::string_view trim_view(std::string_view input) {
  std::size_t start = 0;
  while (start < input.size() && std::isspace(static_cast<unsigned char>(input[start])) != 0) {
    ++start;
  }

  std::size_t end = input.size();
  while (end > start && std::isspace(static_cast<unsigned char>(input[end - 1])) != 0) {
    --end;
  }

  return input.substr(start, end - start);
}

[[nodiscard]] std::vector<std::string> split_statements(std::string_view source) {
  std::vector<std::string> statements;
  std::string current;

  for (const char ch : source) {
    if (ch == ';' || ch == '\n') {
      const std::string trimmed = trim_copy(current);
      if (!trimmed.empty()) {
        statements.push_back(trimmed);
      }
      current.clear();
      continue;
    }
    current.push_back(ch);
  }

  const std::string trimmed = trim_copy(current);
  if (!trimmed.empty()) {
    statements.push_back(trimmed);
  }

  return statements;
}

struct parsed_node_token final {
  std::string key;
  std::string label;
  bool has_explicit_label{ false };
};

[[nodiscard]] parsed_node_token parse_node_token(std::string_view token) {
  const std::string trimmed = trim_copy(token);
  if (trimmed.empty()) {
    return {};
  }

  const std::size_t bracket_open = trimmed.find('[');
  const std::size_t bracket_close = trimmed.rfind(']');
  if (bracket_open != std::string::npos && bracket_close != std::string::npos && bracket_close > bracket_open) {
    const std::string key = trim_copy(std::string_view(trimmed).substr(0, bracket_open));
    const std::string label = trim_copy(std::string_view(trimmed).substr(bracket_open + 1, bracket_close - bracket_open - 1));
    return {
      .key = key.empty() ? label : key,
      .label = label.empty() ? key : label,
      .has_explicit_label = true
    };
  }

  const std::size_t paren_open = trimmed.find('(');
  const std::size_t paren_close = trimmed.rfind(')');
  if (paren_open != std::string::npos && paren_close != std::string::npos && paren_close > paren_open) {
    const std::string key = trim_copy(std::string_view(trimmed).substr(0, paren_open));
    std::string label = trim_copy(std::string_view(trimmed).substr(paren_open + 1, paren_close - paren_open - 1));
    if (!label.empty() && label.front() == '"' && label.back() == '"' && label.size() >= 2) {
      label = label.substr(1, label.size() - 2);
    }
    return {
      .key = key.empty() ? label : key,
      .label = label.empty() ? key : label,
      .has_explicit_label = true
    };
  }

  return {
    .key = trimmed,
    .label = trimmed,
    .has_explicit_label = false
  };
}

[[nodiscard]] bool parse_header(std::string_view header, graph_direction& direction) {
  const std::string_view trimmed = trim_view(header);
  std::string_view remainder;
  if (starts_with_case_insensitive(trimmed, "graph")) {
    remainder = trim_view(trimmed.substr(5));
  } else if (starts_with_case_insensitive(trimmed, "flowchart")) {
    remainder = trim_view(trimmed.substr(9));
  } else {
    return false;
  }

  const std::string tail = trim_copy(remainder);
  if (tail == "LR" || tail == "RL") {
    direction = graph_direction::left_right;
  } else {
    direction = graph_direction::top_down;
  }

  return true;
}

[[nodiscard]] int estimate_node_width(std::string_view label) {
  constexpr int kMinNodeWidth = 148;
  constexpr int kMaxNodeWidth = 320;
  constexpr int kHorizontalPadding = 32;
  constexpr int kGlyphWidth = 8;

  const std::size_t safe_length = std::min<std::size_t>(label.size(), 256);
  const int estimated = static_cast<int>(safe_length) * kGlyphWidth + kHorizontalPadding;
  return std::clamp(estimated, kMinNodeWidth, kMaxNodeWidth);
}

[[nodiscard]] bool parse_graph(std::string_view source, graph_spec& graph) {
  const std::vector<std::string> statements = split_statements(source);
  if (statements.empty()) {
    return false;
  }

  const std::string header = trim_copy(statements.front());
  if (!parse_header(header, graph.direction)) {
    return false;
  }

  std::unordered_map<std::string, std::size_t> node_index;
  auto ensure_node = [&](const parsed_node_token& parsed) -> bool {
    if (parsed.key.empty()) {
      return false;
    }
    const auto it = node_index.find(parsed.key);
    if (it != node_index.end()) {
      if (parsed.has_explicit_label || !graph.nodes[it->second].has_explicit_label) {
        graph.nodes[it->second].label = parsed.label.empty() ? parsed.key : parsed.label;
        graph.nodes[it->second].has_explicit_label = parsed.has_explicit_label;
      }
      return true;
    }
    node_index.emplace(parsed.key, graph.nodes.size());
    graph.nodes.push_back({
      .key = parsed.key,
      .label = parsed.label.empty() ? parsed.key : parsed.label,
      .has_explicit_label = parsed.has_explicit_label
    });
    return true;
  };

  for (std::size_t index = 1; index < statements.size(); ++index) {
    const std::string statement = trim_copy(statements[index]);
    if (statement.empty()) {
      continue;
    }

    if (statement.find("-->") == std::string::npos) {
      const auto node = parse_node_token(statement);
      if (!ensure_node(node)) {
        return false;
      }
      continue;
    }

    std::size_t cursor = 0;
    const std::size_t first_edge = statement.find("-->");
    const auto first_node = parse_node_token(std::string_view(statement).substr(0, first_edge));
    if (!ensure_node(first_node)) {
      return false;
    }

    std::string previous_key = first_node.key;
    cursor = first_edge;

    while (cursor != std::string::npos) {
      const std::size_t next_token_start = cursor + 3;
      const std::size_t next_edge = statement.find("-->", next_token_start);
      const std::string_view next_token = next_edge == std::string::npos
        ? std::string_view(statement).substr(next_token_start)
        : std::string_view(statement).substr(next_token_start, next_edge - next_token_start);

      const auto next_node = parse_node_token(next_token);
      if (!ensure_node(next_node)) {
        return false;
      }

      graph.edges.push_back({ previous_key, next_node.key });
      previous_key = next_node.key;
      cursor = next_edge;
    }
  }

  return !graph.nodes.empty();
}

[[nodiscard]] std::string render_svg(const graph_spec& graph) {
  constexpr int node_height = 56;
  constexpr int horizontal_gap = 52;
  constexpr int vertical_gap = 48;
  constexpr int padding = 24;

  const std::size_t count = graph.nodes.size();
  const bool horizontal = graph.direction == graph_direction::left_right;
  std::unordered_map<std::string, node_layout> node_boxes;
  int width = padding * 2;
  int height = padding * 2;

  for (std::size_t index = 0; index < count; ++index) {
    const int node_width = estimate_node_width(graph.nodes[index].label);
    const int x = [&]() {
      if (!horizontal) {
        return padding;
      }

      int offset = padding;
      for (std::size_t previous = 0; previous < index; ++previous) {
        offset += estimate_node_width(graph.nodes[previous].label) + horizontal_gap;
      }
      return offset;
    }();
    const int y = horizontal ? padding : padding + static_cast<int>(index) * (node_height + vertical_gap);
    const node_layout layout{
      .x = x,
      .y = y,
      .width = node_width,
      .height = node_height,
      .center_x = x + node_width / 2,
      .center_y = y + node_height / 2
    };
    node_boxes.emplace(graph.nodes[index].key, layout);

    width = std::max(width, x + node_width + padding);
    height = std::max(height, y + node_height + padding);
  }

  std::string out;
  out.reserve(512 + count * 256 + graph.edges.size() * 128);
  out.append("<figure class=\"");
  out.append(kMermaidPlaceholderClass);
  out.append("\" ");
  out.append(kRenderedMarker);
  out.append(" data-mermaid-width=\"");
  out.append(std::to_string(width));
  out.append("\" data-mermaid-height=\"");
  out.append(std::to_string(height));
  out.append("\"");
  out.append("><svg class=\"mermaid\" xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 ");
  out.append(std::to_string(width));
  out.push_back(' ');
  out.append(std::to_string(height));
  out.append("\" width=\"");
  out.append(std::to_string(width));
  out.append("\" height=\"");
  out.append(std::to_string(height));
  out.append("\" preserveAspectRatio=\"xMidYMid meet\" role=\"img\" aria-label=\"Mermaid diagram\">");
  out.append("<defs><marker id=\"arrow\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\"><path d=\"M 0 0 L 10 5 L 0 10 z\" fill=\"#71717a\" /></marker></defs>");

  for (const auto& edge : graph.edges) {
    const auto from_it = node_boxes.find(edge.from_key);
    const auto to_it = node_boxes.find(edge.to_key);
    if (from_it == node_boxes.end() || to_it == node_boxes.end()) {
      continue;
    }

    const node_layout& from = from_it->second;
    const node_layout& to = to_it->second;
    const int x1 = horizontal ? from.x + from.width : from.center_x;
    const int y1 = horizontal ? from.center_y : from.y + from.height;
    const int x2 = horizontal ? to.x : to.center_x;
    const int y2 = horizontal ? to.center_y : to.y;

    out.append("<line x1=\"");
    out.append(std::to_string(x1));
    out.append("\" y1=\"");
    out.append(std::to_string(y1));
    out.append("\" x2=\"");
    out.append(std::to_string(x2));
    out.append("\" y2=\"");
    out.append(std::to_string(y2));
    out.append("\" stroke=\"#71717a\" stroke-width=\"2\" marker-end=\"url(#arrow)\" />");
  }

  for (std::size_t index = 0; index < count; ++index) {
    const node_layout& box = node_boxes.at(graph.nodes[index].key);
    const std::string label = escape_html(graph.nodes[index].label);

    out.append("<rect x=\"");
    out.append(std::to_string(box.x));
    out.append("\" y=\"");
    out.append(std::to_string(box.y));
    out.append("\" width=\"");
    out.append(std::to_string(box.width));
    out.append("\" height=\"");
    out.append(std::to_string(box.height));
    out.append("\" rx=\"16\" fill=\"#ffffff\" stroke=\"#d4d4d8\" stroke-width=\"1.5\" />");
    out.append("<text x=\"");
    out.append(std::to_string(box.center_x));
    out.append("\" y=\"");
    out.append(std::to_string(box.center_y));
    out.append("\" text-anchor=\"middle\" dominant-baseline=\"middle\" fill=\"#18181b\" font-size=\"14\" font-family=\"Google Sans, Noto Sans SC, system-ui, sans-serif\">");
    out.append(label);
    out.append("</text>");
  }

  out.append("</svg></figure>");
  return out;
}

} // namespace

std::string render_block(std::string_view source) {
  graph_spec graph;
  if (!parse_graph(source, graph) || graph.edges.empty()) {
    return render_placeholder(source);
  }

  return render_svg(graph);
}

} // namespace fsusblog::wasm::markdown::mermaid
