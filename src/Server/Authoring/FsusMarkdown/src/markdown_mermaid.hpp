#pragma once

#include <cstddef>
#include <string>
#include <string_view>

namespace fsusblog::wasm::markdown::mermaid {

[[nodiscard]] std::string render_block(std::string_view source, std::size_t diagram_index = 0);

} // namespace fsusblog::wasm::markdown::mermaid
