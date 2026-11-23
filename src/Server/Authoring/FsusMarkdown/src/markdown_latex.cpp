#include "markdown_latex.hpp"

#include <cctype>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace fsusblog::wasm::markdown::latex {
namespace {

constexpr std::string_view kLatexPlaceholderClass = "markdown-renderer__latex";
constexpr std::string_view kPlaceholderTitleClass = "markdown-renderer__placeholder-title";
constexpr std::string_view kCodeClass = "shiki";

enum class token_kind : std::uint8_t {
  identifier = 0,
  number = 1,
  command = 2,
  op = 3,
  lbrace = 4,
  rbrace = 5,
  lparen = 6,
  rparen = 7,
  underscore = 8,
  caret = 9,
  end = 10
};

struct token final {
  token_kind kind{ token_kind::end };
  std::string text;
};

class tokenizer final {
public:
  explicit tokenizer(std::string_view source)
    : source_(source) {}

  [[nodiscard]] token next() {
    skip_spaces();
    if (index_ >= source_.size()) {
      return { token_kind::end, {} };
    }

    const char ch = source_[index_];
    if (std::isalpha(static_cast<unsigned char>(ch)) != 0) {
      return consume_identifier();
    }
    if (std::isdigit(static_cast<unsigned char>(ch)) != 0) {
      return consume_number();
    }
    if (ch == '\\') {
      return consume_command();
    }

    ++index_;
    switch (ch) {
      case '{': return { token_kind::lbrace, "{" };
      case '}': return { token_kind::rbrace, "}" };
      case '(': return { token_kind::lparen, "(" };
      case ')': return { token_kind::rparen, ")" };
      case '_': return { token_kind::underscore, "_" };
      case '^': return { token_kind::caret, "^" };
      case '+':
      case '-':
      case '=':
      case '*':
      case '/':
      case '<':
      case '>':
        return { token_kind::op, std::string(1, ch) };
      default:
        return { token_kind::end, {} };
    }
  }

private:
  [[nodiscard]] token consume_identifier() {
    const std::size_t start = index_;
    while (index_ < source_.size() && std::isalpha(static_cast<unsigned char>(source_[index_])) != 0) {
      ++index_;
    }
    return { token_kind::identifier, std::string(source_.substr(start, index_ - start)) };
  }

  [[nodiscard]] token consume_number() {
    const std::size_t start = index_;
    while (index_ < source_.size() && (std::isdigit(static_cast<unsigned char>(source_[index_])) != 0 || source_[index_] == '.')) {
      ++index_;
    }
    return { token_kind::number, std::string(source_.substr(start, index_ - start)) };
  }

  [[nodiscard]] token consume_command() {
    ++index_;
    const std::size_t start = index_;
    while (index_ < source_.size() && std::isalpha(static_cast<unsigned char>(source_[index_])) != 0) {
      ++index_;
    }
    if (start == index_) {
      return { token_kind::end, {} };
    }
    return { token_kind::command, std::string(source_.substr(start, index_ - start)) };
  }

  void skip_spaces() {
    while (index_ < source_.size() && std::isspace(static_cast<unsigned char>(source_[index_])) != 0) {
      ++index_;
    }
  }

  std::string_view source_;
  std::size_t index_{ 0 };
};

class parser final {
public:
  explicit parser(std::string_view source)
    : tokenizer_(source),
      current_(tokenizer_.next()) {}

  [[nodiscard]] bool ok() const {
    return ok_;
  }

  [[nodiscard]] std::string parse_expression() {
    std::string row = parse_row();
    if (!ok_ || current_.kind != token_kind::end) {
      ok_ = false;
      return {};
    }
    return row;
  }

private:
  [[nodiscard]] std::string parse_row(token_kind stop_kind = token_kind::end) {
    std::vector<std::string> parts;

    while (ok_) {
      if (current_.kind == token_kind::end) {
        break;
      }
      if (stop_kind != token_kind::end && current_.kind == stop_kind) {
        break;
      }

      if (current_.kind == token_kind::op) {
        parts.push_back(render_operator(current_.text));
        advance();
        continue;
      }

      std::string atom = parse_atom();
      if (!ok_ || atom.empty()) {
        break;
      }
      parts.push_back(std::move(atom));
    }

    if (!ok_ || parts.empty()) {
      return {};
    }

    if (parts.size() == 1) {
      return parts.front();
    }

    std::string out = "<mrow>";
    for (const auto& part : parts) {
      out.append(part);
    }
    out.append("</mrow>");
    return out;
  }

  [[nodiscard]] std::string parse_primary() {
    std::string base;
    switch (current_.kind) {
      case token_kind::identifier:
        base = "<mi>" + escape_xml(current_.text) + "</mi>";
        advance();
        break;
      case token_kind::number:
        base = "<mn>" + escape_xml(current_.text) + "</mn>";
        advance();
        break;
      case token_kind::lbrace:
        advance();
        base = parse_group();
        break;
      case token_kind::lparen:
        advance();
        base = parse_parenthesized();
        break;
      case token_kind::command:
        base = parse_command();
        break;
      default:
        ok_ = false;
        return {};
    }

    return ok_ ? base : std::string{};
  }

  [[nodiscard]] std::string parse_atom() {
    std::string base = parse_primary();
    if (!ok_ || base.empty()) {
      return {};
    }

    return parse_scripts(std::move(base));
  }

  [[nodiscard]] std::string parse_group() {
    std::string inner = parse_row(token_kind::rbrace);
    if (!ok_ || current_.kind != token_kind::rbrace) {
      ok_ = false;
      return {};
    }
    advance();
    return "<mrow>" + inner + "</mrow>";
  }

  [[nodiscard]] std::string parse_parenthesized() {
    std::string inner = parse_row(token_kind::rparen);
    if (!ok_ || current_.kind != token_kind::rparen) {
      ok_ = false;
      return {};
    }
    advance();
    return "<mrow><mo>(</mo>" + inner + "<mo>)</mo></mrow>";
  }

  [[nodiscard]] std::string parse_command() {
    const std::string name = current_.text;
    advance();

    if (name == "frac") {
      if (current_.kind != token_kind::lbrace) {
        ok_ = false;
        return {};
      }
      advance();
      std::string numerator = parse_group();
      if (!ok_ || current_.kind != token_kind::lbrace) {
        ok_ = false;
        return {};
      }
      advance();
      std::string denominator = parse_group();
      if (!ok_) {
        return {};
      }
      return "<mfrac>" + numerator + denominator + "</mfrac>";
    }

    if (name == "sqrt") {
      if (current_.kind != token_kind::lbrace) {
        ok_ = false;
        return {};
      }
      advance();
      std::string content = parse_group();
      if (!ok_) {
        return {};
      }
      return "<msqrt>" + content + "</msqrt>";
    }

    const auto command_operator = command_operators().find(name);
    if (command_operator != command_operators().end()) {
      return "<mo>" + command_operator->second + "</mo>";
    }

    const auto greek = greek_symbols().find(name);
    if (greek != greek_symbols().end()) {
      return "<mi>" + greek->second + "</mi>";
    }

    const auto function = function_names().find(name);
    if (function != function_names().end()) {
      return "<mi>" + function->second + "</mi>";
    }

    ok_ = false;
    return {};
  }

  [[nodiscard]] std::string parse_scripts(std::string base) {
    std::string subscript;
    std::string superscript;

    while (current_.kind == token_kind::underscore || current_.kind == token_kind::caret) {
      const token_kind script_kind = current_.kind;
      advance();
      std::string value = parse_script_atom();
      if (!ok_ || value.empty()) {
        return {};
      }
      if (script_kind == token_kind::underscore) {
        subscript = std::move(value);
      } else {
        superscript = std::move(value);
      }
    }

    if (!subscript.empty() && !superscript.empty()) {
      return "<msubsup>" + base + subscript + superscript + "</msubsup>";
    }
    if (!subscript.empty()) {
      return "<msub>" + base + subscript + "</msub>";
    }
    if (!superscript.empty()) {
      return "<msup>" + base + superscript + "</msup>";
    }
    return base;
  }

  [[nodiscard]] std::string parse_script_atom() {
    if (current_.kind == token_kind::lbrace) {
      advance();
      return parse_group();
    }
    return parse_primary();
  }

  [[nodiscard]] static std::string render_operator(std::string_view op) {
    if (op == "*") {
      return "<mo>&#x2217;</mo>";
    }
    return "<mo>" + escape_xml(op) + "</mo>";
  }

  [[nodiscard]] static std::string escape_xml(std::string_view input) {
    std::string escaped;
    escaped.reserve(input.size() + (input.size() / 4));
    for (const char ch : input) {
      switch (ch) {
        case '&': escaped.append("&amp;"); break;
        case '<': escaped.append("&lt;"); break;
        case '>': escaped.append("&gt;"); break;
        case '"': escaped.append("&quot;"); break;
        case '\'': escaped.append("&#39;"); break;
        default: escaped.push_back(ch); break;
      }
    }
    return escaped;
  }

  [[nodiscard]] static const std::unordered_map<std::string, std::string>& greek_symbols() {
    static const std::unordered_map<std::string, std::string> value = {
      { "alpha", "α" }, { "beta", "β" }, { "gamma", "γ" }, { "theta", "θ" },
      { "lambda", "λ" }, { "mu", "μ" }, { "pi", "π" }, { "sigma", "σ" }, { "phi", "φ" }
    };
    return value;
  }

  [[nodiscard]] static const std::unordered_map<std::string, std::string>& command_operators() {
    static const std::unordered_map<std::string, std::string> value = {
      { "cdot", "&#x22C5;" },
      { "times", "&#x00D7;" },
      { "div", "&#x00F7;" },
      { "pm", "&#x00B1;" },
      { "mp", "&#x2213;" },
      { "le", "&#x2264;" },
      { "leq", "&#x2264;" },
      { "ge", "&#x2265;" },
      { "geq", "&#x2265;" },
      { "ne", "&#x2260;" },
      { "neq", "&#x2260;" },
      { "approx", "&#x2248;" },
      { "to", "&#x2192;" },
      { "leftarrow", "&#x2190;" },
      { "rightarrow", "&#x2192;" },
      { "leftrightarrow", "&#x2194;" },
      { "sum", "&#x2211;" },
      { "prod", "&#x220F;" },
      { "int", "&#x222B;" },
      { "infty", "&#x221E;" }
    };
    return value;
  }

  [[nodiscard]] static const std::unordered_map<std::string, std::string>& function_names() {
    static const std::unordered_map<std::string, std::string> value = {
      { "sin", "sin" }, { "cos", "cos" }, { "tan", "tan" }, { "cot", "cot" }, { "sec", "sec" }, { "csc", "csc" },
      { "log", "log" }, { "ln", "ln" }, { "exp", "exp" }, { "lim", "lim" }, { "min", "min" }, { "max", "max" }
    };
    return value;
  }

  void advance() {
    current_ = tokenizer_.next();
  }

  tokenizer tokenizer_;
  token current_;
  bool ok_{ true };
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

[[nodiscard]] std::string escape_and_wrap_code(std::string_view code) {
  std::string out;
  out.reserve(code.size() + 64);
  out.append("<pre class=\"");
  out.append(kCodeClass);
  out.append("\"><code class=\"language-latex\">");
  out.append(escape_html(code));
  out.append("</code></pre>");
  return out;
}

[[nodiscard]] std::string render_placeholder(std::string_view source, fragment_kind kind) {
  std::string out;
  out.reserve(source.size() + 192);

  if (kind == fragment_kind::inline_math) {
    out.append("<span class=\"");
    out.append(kLatexPlaceholderClass);
    out.append("\" data-latex-placeholder=\"true\"><span class=\"");
    out.append(kPlaceholderTitleClass);
    out.append("\">LaTeX 公式将在交互层激活</span><code class=\"language-latex\">");
    out.append(escape_html(source));
    out.append("</code></span>");
    return out;
  }

  out.append("<div class=\"");
  out.append(kLatexPlaceholderClass);
  out.append("\" data-latex-placeholder=\"true\">");
  out.append("<p class=\"");
  out.append(kPlaceholderTitleClass);
  out.append("\">LaTeX 公式将在交互层激活</p>");
  out.append(escape_and_wrap_code(source));
  out.append("</div>");
  return out;
}

[[nodiscard]] std::string render_mathml(std::string_view source, fragment_kind kind) {
  parser math_parser(source);
  const std::string expression = math_parser.parse_expression();
  if (!math_parser.ok() || expression.empty()) {
    return {};
  }

  std::string out;
  out.reserve(expression.size() + 160);
  if (kind == fragment_kind::inline_math) {
    out.append("<span class=\"");
    out.append(kLatexPlaceholderClass);
    out.append("\" data-latex-rendered=\"mathml\"><math xmlns=\"http://www.w3.org/1998/Math/MathML\">");
    out.append(expression);
    out.append("</math></span>");
    return out;
  }

  out.append("<div class=\"");
  out.append(kLatexPlaceholderClass);
  out.append("\" data-latex-rendered=\"mathml\"><math xmlns=\"http://www.w3.org/1998/Math/MathML\" display=\"block\">");
  out.append(expression);
  out.append("</math></div>");
  return out;
}

} // namespace

std::string render_fragment(const render_input& input) {
  const std::string rendered = render_mathml(input.source, input.kind);
  if (!rendered.empty()) {
    return rendered;
  }
  return render_placeholder(input.source, input.kind);
}

} // namespace fsusblog::wasm::markdown::latex
