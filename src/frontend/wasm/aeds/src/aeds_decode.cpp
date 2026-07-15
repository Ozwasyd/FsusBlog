#include "aeds_decode.hpp"

#include "aeds_crc32.hpp"
#include "aeds_frame.hpp"
#include "pod_views.hpp"

namespace fsusblog::aeds {

namespace {

std::uint16_t read_u16_le(const std::uint8_t* data) {
  return static_cast<std::uint16_t>(data[0])
    | static_cast<std::uint16_t>(static_cast<std::uint16_t>(data[1]) << 8u);
}

std::uint32_t read_u32_le(const std::uint8_t* data) {
  return static_cast<std::uint32_t>(data[0])
    | (static_cast<std::uint32_t>(data[1]) << 8u)
    | (static_cast<std::uint32_t>(data[2]) << 16u)
    | (static_cast<std::uint32_t>(data[3]) << 24u);
}

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
    case ErrorCode::VersionMismatch:
      return "version_mismatch";
    case ErrorCode::HeaderLengthMismatch:
      return "header_length_mismatch";
    case ErrorCode::PayloadCrcMismatch:
      return "payload_crc_mismatch";
    case ErrorCode::ArticlePayloadInvalid:
      return "article_payload_invalid";
    case ErrorCode::FrameTypeUnsupported:
      return "frame_type_unsupported";
    default:
      return "decode_failed";
  }
}

DecodeResult decode_frame(const std::uint8_t* frame, std::size_t frame_len) {
  if (frame == nullptr || frame_len < kHeaderSize) {
    return make_error(ErrorCode::InvalidInput);
  }

  const std::uint32_t magic = read_u32_le(frame);
  const std::uint8_t version = frame[4];
  const std::uint8_t header_length = frame[5];
  const std::uint16_t frame_type = read_u16_le(frame + 8);
  const std::uint32_t payload_length = read_u32_le(frame + 10);
  const std::uint16_t payload_crc16 = read_u16_le(frame + 14);

  if (magic != kMagic) {
    return make_error(ErrorCode::MagicMismatch);
  }

  if (version != kVersion) {
    return make_error(ErrorCode::VersionMismatch);
  }

  if (header_length != kHeaderSize) {
    return make_error(ErrorCode::HeaderLengthMismatch);
  }

  if (frame_len != static_cast<std::size_t>(payload_length) + kHeaderSize) {
    return make_error(ErrorCode::PayloadLengthMismatch);
  }

  if (!is_known_frame_type(frame_type)) {
    return make_error(ErrorCode::FrameTypeUnsupported);
  }

  const std::uint8_t* payload = frame + kHeaderSize;
  const std::uint16_t payload_crc = compute_crc16(payload, payload_length);
  if (payload_crc != payload_crc16) {
    return make_error(ErrorCode::PayloadCrcMismatch);
  }

  if (frame_type == static_cast<std::uint16_t>(FrameType::ArticleDetail)) {
    fsusblog::pod::ParsedArticleDetail parsed{};
    if (!fsusblog::pod::parse_article_detail_payload(payload, payload_length, &parsed)) {
      return make_error(ErrorCode::ArticlePayloadInvalid);
    }
  }

  DecodeResult ok{};
  ok.ok = true;
  ok.frame_type = frame_type;
  ok.payload_ptr = payload;
  ok.payload_len = payload_length;
  ok.error_code = ErrorCode::None;
  ok.error = nullptr;
  return ok;
}

} // namespace fsusblog::aeds
