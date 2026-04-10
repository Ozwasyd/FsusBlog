#include "markdown_latex.hpp"

#include <cstdlib>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace latex = fsusblog::wasm::markdown::latex;

namespace {

struct test_case final {
  std::string_view name;
  std::string_view source;
  std::vector<std::string_view> expected_fragments;
};

bool contains_all(std::string_view output, const std::vector<std::string_view>& expected_fragments) {
  for (const std::string_view fragment : expected_fragments) {
    if (!output.contains(fragment)) {
      return false;
    }
  }
  return true;
}

} // namespace

int main() {
  const std::vector<test_case> cases = {
    {
      "grouped_parentheses_support_scripts",
      "(x+y)^2",
      {
        "<msup>",
        "<mrow><mo>(</mo><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow><mo>)</mo></mrow>",
        "<mn>2</mn>",
        "</msup>"
      }
    },
    {
      "grouped_scripts_attach_to_base",
      "x^y_1",
      {
        "<msubsup><mi>x</mi><mn>1</mn><mi>y</mi></msubsup>"
      }
    },
    {
      "grouped_scripts_attach_to_base_in_reverse_order",
      "x_i^j",
      {
        "<msubsup><mi>x</mi><mi>i</mi><mi>j</mi></msubsup>"
      }
    },
    {
      "scripted_big_operator_with_grouped_bounds",
      "\\sum_{i=1}^{n} x_i",
      {
        "<msubsup><mo>&#x2211;</mo><mrow><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow></mrow><mrow><mi>n</mi></mrow></msubsup>",
        "<msub><mi>x</mi><mi>i</mi></msub>"
      }
    },
    {
      "command_operators_render",
      "a \\cdot b \\le c \\to d",
      {
        "<mi>a</mi><mo>&#x22C5;</mo><mi>b</mi><mo>&#x2264;</mo><mi>c</mi><mo>&#x2192;</mo><mi>d</mi>"
      }
    },
    {
      "common_functions_render",
      "\\lim_{n \\to \\infty} \\frac{1}{n}",
      {
        "<msub><mi>lim</mi><mrow><mrow><mi>n</mi><mo>&#x2192;</mo><mo>&#x221E;</mo></mrow></mrow></msub>",
        "<mfrac><mrow><mn>1</mn></mrow><mrow><mi>n</mi></mrow></mfrac>"
      }
    }
  };

  bool ok = true;
  for (const auto& test : cases) {
    const std::string rendered = latex::render_fragment({
      test.source,
      latex::fragment_kind::inline_math
    });

    if (!contains_all(rendered, test.expected_fragments)) {
      ok = false;
      std::cerr << "FAILED: " << test.name << '\n';
      std::cerr << "source: " << test.source << '\n';
      std::cerr << "output: " << rendered << '\n';
    }
  }

  return ok ? EXIT_SUCCESS : EXIT_FAILURE;
}
