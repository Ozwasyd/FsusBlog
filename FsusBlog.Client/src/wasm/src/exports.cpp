#include "aeds_decode.hpp"

#include <array>
#include <cstddef>
#include <cstdlib>
#include <cstdint>
#include <cstring>

namespace {

std::array<char, 128> g_error{};
std::uint32_t g_payload_ptr = 0;
std::uint32_t g_payload_len = 0;
std::uint16_t g_frame_type = 0;

void set_error(const char* err) {
  g_error.fill('\0');
  if (err == nullptr) {
    return;
  }

  const std::size_t max_copy = g_error.size() - 1u;
  std::strncpy(g_error.data(), err, max_copy);
  g_error[max_copy] = '\0';
}

} // namespace

extern "C" {

int decode_aeds(const std::uint8_t* data, int len) {
  if (data == nullptr || len <= 0) {
    set_error("invalid_input");
    g_payload_ptr = 0;
    g_payload_len = 0;
    g_frame_type = 0;
    return 0;
  }

  const fsusblog::aeds::DecodeResult result = fsusblog::aeds::decode_frame(data, static_cast<std::size_t>(len));
  if (!result.ok) {
    set_error(result.error);
    g_payload_ptr = 0;
    g_payload_len = 0;
    g_frame_type = 0;
    return 0;
  }

  set_error(nullptr);
  g_payload_ptr = static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(result.payload_ptr));
  g_payload_len = result.payload_len;
  g_frame_type = result.frame_type;
  return 1;
}

std::uint32_t get_last_payload_ptr() { return g_payload_ptr; }
std::uint32_t get_last_payload_len() { return g_payload_len; }
std::uint16_t get_last_frame_type() { return g_frame_type; }
const char* get_last_error_ptr() { return g_error.data(); }
int get_last_error_len() { return static_cast<int>(std::strlen(g_error.data())); }
std::uint32_t alloc_buffer(int size) {
  if (size <= 0) {
    return 0;
  }

  void* ptr = std::malloc(static_cast<std::size_t>(size));
  return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(ptr));
}
void free_buffer(std::uint32_t ptr) {
  if (ptr == 0) {
    return;
  }

  std::free(reinterpret_cast<void*>(static_cast<std::uintptr_t>(ptr)));
}

}
