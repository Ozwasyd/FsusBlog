#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace fsusblog::wasm::markdown::latex {

enum class fragment_kind : std::uint8_t {
  inline_math = 0,
  block_math = 1
};

struct render_input final {
  std::string_view source;
  fragment_kind kind;
};

[[nodiscard]] std::string render_fragment(const render_input& input);

} // namespace fsusblog::wasm::markdown::latex
