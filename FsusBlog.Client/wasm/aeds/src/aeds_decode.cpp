#include "aeds_decode.hpp"

#include "aeds_crc32.hpp"
#include "aeds_frame.hpp"
#include "pod_views.hpp"

#include <cstring>

namespace fsusblog::aeds {

namespace {

DecodeResult make_error(ErrorCode error_code) {
  DecodeResult result{};
  result.ok = false;
  result.frame_type = static_cast<std::uint16_t>(FrameType::Unknown);
  result.payload_ptr = nullptr;
  result.payload_len = 0;
  result.error_code = error_code;
  result.error = to_error_string(error_code);
  return result;
}

} // namespace

const char* to_error_string(ErrorCode error_code) {
  switch (error_code) {
    case ErrorCode::None:
      return "";
    case ErrorCode::InvalidInput:
      return "frame_too_short";
    case ErrorCode::MagicMismatch:
      return "magic_mismatch";
    case ErrorCode::PayloadLengthMismatch:
      return "payload_length_mismatch";
    case ErrorCode::HeaderCrcMismatch:
      return "header_crc_mismatch";
    case ErrorCode::PayloadCrcMismatch:
      return "payload_crc_mismatch";
    case ErrorCode::ArticlePayloadInvalid:
      return "article_payload_invalid";
    default:
      return "decode_failed";
  }
}

DecodeResult decode_frame(const std::uint8_t* frame, std::size_t frame_len) {
  if (frame == nullptr || frame_len < sizeof(AedsFrameHeader)) {
    return make_error(ErrorCode::InvalidInput);
  }

  const auto* header = reinterpret_cast<const AedsFrameHeader*>(frame);
  if (header->magic != kMagic) {
    return make_error(ErrorCode::MagicMismatch);
  }

  if (frame_len != static_cast<std::size_t>(header->payload_length) + sizeof(AedsFrameHeader)) {
    return make_error(ErrorCode::PayloadLengthMismatch);
  }

  AedsFrameHeader tmp = *header;
  tmp.header_crc32 = 0;

  const std::uint32_t header_crc = compute_crc32(reinterpret_cast<const std::uint8_t*>(&tmp), sizeof(AedsFrameHeader));
  if (header_crc != header->header_crc32) {
    return make_error(ErrorCode::HeaderCrcMismatch);
  }

  const std::uint8_t* payload = frame + sizeof(AedsFrameHeader);
  const std::uint32_t payload_crc = compute_crc32(payload, header->payload_length);
  if (payload_crc != header->payload_crc32) {
    return make_error(ErrorCode::PayloadCrcMismatch);
  }

  if (header->frame_type == static_cast<std::uint16_t>(FrameType::ArticleDetail)) {
    fsusblog::pod::ParsedArticleDetail parsed{};
    if (!fsusblog::pod::parse_article_detail_payload(payload, header->payload_length, &parsed)) {
      return make_error(ErrorCode::ArticlePayloadInvalid);
    }
  }

  DecodeResult ok{};
  ok.ok = true;
  ok.frame_type = header->frame_type;
  ok.payload_ptr = payload;
  ok.payload_len = header->payload_length;
  ok.error_code = ErrorCode::None;
  ok.error = nullptr;
  return ok;
}

} // namespace fsusblog::aeds
