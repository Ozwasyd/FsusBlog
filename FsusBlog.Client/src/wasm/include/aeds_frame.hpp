#pragma once

#include <cstdint>

namespace fsusblog::aeds {

static constexpr std::uint32_t kMagic = 0x53444541U; // "AEDS" little-endian
static constexpr std::uint32_t kHeaderSize = 24U;

#pragma pack(push, 1)
struct AedsFrameHeader {
  std::uint32_t magic;
  std::uint16_t version;
  std::uint16_t frame_type;
  std::uint32_t flags;
  std::uint32_t payload_length;
  std::uint32_t header_crc32;
  std::uint32_t payload_crc32;
};
#pragma pack(pop)

static_assert(sizeof(AedsFrameHeader) == kHeaderSize, "AedsFrameHeader size mismatch");

enum class FrameType : std::uint16_t {
  Unknown = 0,
  ArticleList = 1,
  ArticleDetail = 2,
  ArticleHot = 3,
  ArticleSearch = 4,
  CommentArticleCursor = 5,
  CommentUserCursor = 6,
  AdminStats = 7,
};

} // namespace fsusblog::aeds
