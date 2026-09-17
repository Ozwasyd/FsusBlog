#include "src/frontend/wasm/aeds/src/exports.cpp"

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace {

[[noreturn]] void fail_closed() {
  __builtin_trap();
}

} // namespace

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
  if (size > 8192U) return 0;
  const int arena_size = static_cast<int>(size == 0U ? 1U : size);
  const std::uint64_t input_token = reserve_io_buffer(arena_size);
  const std::uintptr_t input_address = get_io_buffer_ptr(input_token);
  if (input_token == 0U || input_address == 0U) fail_closed();
  if (size > 0U) std::memcpy(reinterpret_cast<void*>(input_address), data, size);

  const int decoded = decode_io_buffer(input_token, static_cast<int>(size));
  if (get_io_buffer_ptr(input_token) != 0U) fail_closed();
  const std::uint64_t payload_token = get_last_payload_token();
  if (decoded == 1) {
    if (payload_token == 0U) fail_closed();
    const std::uintptr_t payload_address = get_last_payload_ptr(payload_token);
    const std::uint32_t payload_length = get_last_payload_len(payload_token);
    if (payload_length > 0U && payload_address == 0U) fail_closed();
  } else if (payload_token != 0U) {
    fail_closed();
  }

  const std::uint64_t replacement_token = reserve_io_buffer(arena_size + 1);
  if (replacement_token == 0U || replacement_token == input_token || replacement_token == payload_token) fail_closed();
  if (get_last_payload_ptr(payload_token) != 0U || get_last_payload_len(payload_token) != 0U) fail_closed();
  if (get_io_buffer_ptr(input_token) != 0U || get_io_buffer_ptr(replacement_token) == 0U) fail_closed();
  clear_io_buffer(0);
  if (get_io_buffer_ptr(replacement_token) != 0U) fail_closed();
  return 0;
}
