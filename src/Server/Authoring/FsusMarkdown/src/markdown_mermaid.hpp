#pragma once

#include <string>
#include <string_view>

namespace fsusblog::wasm::markdown::mermaid {

[[nodiscard]] std::string render_block(std::string_view source);

} // namespace fsusblog::wasm::markdown::mermaid
