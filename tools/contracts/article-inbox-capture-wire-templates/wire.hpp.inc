#pragma once
#include "writing_aid_preference_wire.generated.hpp"
#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace FsusBlog::Aeds::ArticleInboxCaptureWire
{
class Reader
{
    const std::uint8_t* bytes_;
    std::uint32_t length_;
    std::uint32_t offset_ = 0;
public:
    Reader(const std::uint8_t* bytes, std::uint32_t length) : bytes_(bytes), length_(length) {}
    bool Integer(unsigned width, std::uint64_t& value)
    {
        if (width > length_ - offset_) return false;
        value = 0;
        for (unsigned n = 0; n < width; ++n) value |= static_cast<std::uint64_t>(bytes_[offset_++]) << (n * 8);
        return true;
    }
    bool Positive(unsigned width, std::uint64_t& value)
    {
        return Integer(width, value) && value > 0 && value <= (width == 4 ? 2147483647ULL : 9223372036854775807ULL);
    }
    bool Boolean(bool& value)
    {
        std::uint64_t byte;
        if (!Integer(1, byte) || byte > 1) return false;
        value = byte == 1;
        return true;
    }
    bool Guid(std::array<std::uint8_t, 16>& value)
    {
        if (16 > length_ - offset_) return false;
        bool nonzero = false;
        for (auto& byte : value) { byte = bytes_[offset_++]; nonzero |= byte != 0; }
        return nonzero;
    }
    bool Text(std::string& value, std::uint32_t limit)
    {
        std::uint64_t count;
        if (!Integer(4, count) || count > limit || count > length_ - offset_) return false;
        value.assign(reinterpret_cast<const char*>(bytes_ + offset_), static_cast<std::size_t>(count));
        offset_ += static_cast<std::uint32_t>(count);
        return true;
    }
    bool Consumed() const { return offset_ == length_; }
};
inline bool White(std::uint32_t code)
{
    return code >= 9 && code <= 13 || WritingAidPreferenceWire::Whitespace(code);
}
inline bool Source(const std::string& value, std::size_t maxUnits, bool forbidControls, bool& hasText)
{
    std::vector<std::uint32_t> scalars;
    if (!WritingAidPreferenceWire::Scalars(value, scalars)) return false;
    std::size_t units = 0;
    hasText = false;
    for (auto code : scalars)
    {
        units += code > 0xffff ? 2 : 1;
        if (forbidControls && (code < 32 || code >= 127 && code <= 159)) return false;
        hasText |= !White(code);
    }
    return units <= maxUnits;
}
inline bool Hex(const std::string& value, std::size_t size)
{
    if (value.size() != size) return false;
    for (auto code : value) if (!(code >= '0' && code <= '9' || code >= 'a' && code <= 'f')) return false;
    return true;
}
inline bool Scope(Reader& reader)
{
    std::string site;
    return reader.Text(site, 512) && WritingAidPreferenceWire::Coordinate(site);
}
}
namespace FsusBlog::Aeds
{
inline bool ValidateArticleInboxCapturePayload(std::uint16_t type, const std::uint8_t* bytes, std::uint32_t length)
{
    using namespace ArticleInboxCaptureWire;
    constexpr std::uint16_t createType = @CAPTURE_CREATE_FRAME@;
    constexpr std::uint16_t reconcileType = @CAPTURE_RECONCILE_FRAME@;
    constexpr std::uint16_t responseType = @CAPTURE_RESPONSE_FRAME@;
    if (bytes == nullptr || length < 34 || length > (type == responseType ? 882U : 801568U)) return false;
    Reader reader(bytes, length);
    std::uint64_t schema, actor;
    std::array<std::uint8_t, 16> requestId;
    if (!reader.Integer(4, schema) || schema != 1 || !reader.Guid(requestId)) return false;
    if (type == createType || type == reconcileType)
    {
        std::string title, markdown;
        bool hasTitle, hasMarkdown;
        return Scope(reader) && reader.Text(title, 1024) && reader.Text(markdown, 800000)
            && Source(title, 256, true, hasTitle) && Source(markdown, 200000, false, hasMarkdown)
            && (hasTitle || hasMarkdown) && reader.Consumed();
    }
    if (type != responseType || !reader.Positive(8, actor) || !Scope(reader)) return false;
    bool present;
    if (!reader.Boolean(present)) return false;
    if (!present) return reader.Consumed();
    std::array<std::uint8_t, 16> receiptId, originalRequest, audit;
    std::uint64_t owner, article, draft, draftRevision, revision, revisionNo, ticks;
    std::string outbox, auditDigest, sourceDigest, contentDigest;
    bool replay;
    return reader.Guid(receiptId) && reader.Guid(originalRequest) && originalRequest == requestId
        && reader.Positive(8, owner) && owner == actor && reader.Positive(4, article)
        && reader.Positive(8, draft) && reader.Positive(8, draftRevision) && draftRevision == 1
        && reader.Positive(8, revision) && reader.Positive(4, revisionNo) && revisionNo == 1
        && reader.Text(outbox, 32) && Hex(outbox, 32) && reader.Guid(audit)
        && reader.Text(auditDigest, 64) && Hex(auditDigest, 64) && reader.Text(sourceDigest, 64) && Hex(sourceDigest, 64)
        && reader.Text(contentDigest, 64) && Hex(contentDigest, 64) && reader.Positive(8, ticks)
        && ticks <= 3155378975999999999ULL && reader.Boolean(replay) && reader.Consumed();
}
}
