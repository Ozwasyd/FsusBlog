#include "aeds_decode.hpp"

#include "aeds_crc32.hpp"
#include "aeds_frame.hpp"
#include "pod_views.hpp"

#include <cstring>

namespace fsusblog::aeds {

namespace {

DecodeResult make_error(const char* error) {
  DecodeResult result{};
  result.ok = false;
  result.frame_type = static_cast<std::uint16_t>(FrameType::Unknown);
  result.payload_ptr = nullptr;
  result.payload_len = 0;
  result.error = error;
  return result;
}

} // namespace

DecodeResult decode_frame(const std::uint8_t* frame, std::size_t frame_len) {
  if (frame == nullptr || frame_len < sizeof(AedsFrameHeader)) {
    return make_error("frame_too_short");
  }

  const auto* header = reinterpret_cast<const AedsFrameHeader*>(frame);
  if (header->magic != kMagic) {
    return make_error("magic_mismatch");
  }

  if (frame_len != static_cast<std::size_t>(header->payload_length) + sizeof(AedsFrameHeader)) {
    return make_error("payload_length_mismatch");
  }

  AedsFrameHeader tmp = *header;
  tmp.header_crc32 = 0;

  const std::uint32_t header_crc = compute_crc32(reinterpret_cast<const std::uint8_t*>(&tmp), sizeof(AedsFrameHeader));
  if (header_crc != header->header_crc32) {
    return make_error("header_crc_mismatch");
  }

  const std::uint8_t* payload = frame + sizeof(AedsFrameHeader);
  const std::uint32_t payload_crc = compute_crc32(payload, header->payload_length);
  if (payload_crc != header->payload_crc32) {
    return make_error("payload_crc_mismatch");
  }

  if (header->frame_type == static_cast<std::uint16_t>(FrameType::ArticleDetail)) {
    fsusblog::pod::ParsedArticleDetail parsed{};
    if (!fsusblog::pod::parse_article_detail_payload(payload, header->payload_length, &parsed)) {
      return make_error("article_payload_invalid");
    }
  }

  DecodeResult ok{};
  ok.ok = true;
  ok.frame_type = header->frame_type;
  ok.payload_ptr = payload;
  ok.payload_len = header->payload_length;
  ok.error = nullptr;
  return ok;
}

} // namespace fsusblog::aeds
