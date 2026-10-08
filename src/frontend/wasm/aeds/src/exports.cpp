#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

#include "aeds_decode.hpp"
#include "article_list_wire_validation.hpp"
#include "pod_views.hpp"

namespace
{

thread_local std::array<char, 128> t_error{};
thread_local std::vector<std::uint8_t> t_ioArena{};
thread_local const std::uint8_t* t_payloadPtr = nullptr;
thread_local std::uint32_t t_payloadLen = 0;
thread_local std::uint16_t t_frameType = 0;
thread_local std::uint8_t t_errorCode = 0;
thread_local std::string t_lastHtml{};
thread_local std::uint32_t t_ioSize = 0;
thread_local std::uint32_t t_arenaReallocationCount = 0;
thread_local std::uint32_t t_arenaClearCount = 0;
thread_local std::uint64_t t_handleEpoch = 0;
thread_local std::uint64_t t_ioHandleToken = 0;
thread_local std::uint64_t t_payloadHandleToken = 0;
constexpr std::size_t KArticleListRecordSize = FsusBlog::AedsWire::ArticleListRecordBytes;
constexpr std::size_t KCompactTagRecordSize = 12u;
constexpr std::size_t KTagPodSize = 132u;
constexpr std::size_t KCommentItemPodSize = 24u;
constexpr std::size_t KUserCommentPodSize = 460u;
constexpr std::size_t KSiteStatsPodSize = 80u;
constexpr std::size_t KCompactPopularRecordSize = 16u;
constexpr std::size_t KRecentCommentRecordSize = 32u;
constexpr std::size_t KRegionDistributionRecordSize = 12u;
constexpr std::size_t KRecentCommentPodSize = 88u;
constexpr std::size_t KRegionDistributionPodSize = 132u;

void AdvanceHandleEpoch()
{
    // Exported addresses are leases for exactly one epoch; every state-changing call revokes them first.
    if (t_handleEpoch == std::numeric_limits<std::uint64_t>::max())
    {
        t_handleEpoch = 1U;
    }
    else
    {
        ++t_handleEpoch;
    }
    t_ioHandleToken = 0;
    t_payloadHandleToken = 0;
    t_payloadPtr = nullptr;
    t_payloadLen = 0;
    t_frameType = 0;
}

void SetError(const char* err)
{
    t_error.fill('\0');
    if (err == nullptr)
    {
        return;
    }

    const std::size_t MaxCopy = t_error.size() - 1u;
    std::strncpy(t_error.data(), err, MaxCopy);
    t_error[MaxCopy] = '\0';
}

void AppendLiteral(std::string& out, const char* value)
{
    if (value != nullptr)
    {
        out.append(value);
    }
}

void AppendInt(std::string& out, std::int64_t value)
{
    char buffer[32]{};
    const int Len = std::snprintf(buffer, sizeof(buffer), "%lld", static_cast<long long>(value));
    if (Len > 0)
    {
        out.append(buffer, static_cast<std::size_t>(Len));
    }
}

void AppendU32(std::string& out, std::uint32_t value)
{
    char buffer[24]{};
    const int Len = std::snprintf(buffer, sizeof(buffer), "%u", static_cast<unsigned>(value));
    if (Len > 0)
    {
        out.append(buffer, static_cast<std::size_t>(Len));
    }
}

void AppendEscapedAscii(std::string& out, const std::uint8_t* bytes, std::size_t len)
{
    if (bytes == nullptr || len == 0)
    {
        return;
    }

    for (std::size_t i = 0; i < len && bytes[i] != 0; ++i)
    {
        const char Ch = static_cast<char>(bytes[i]);
        switch (Ch)
        {
            case '&':
                out.append("&amp;");
                break;
            case '<':
                out.append("&lt;");
                break;
            case '>':
                out.append("&gt;");
                break;
            case '"':
                out.append("&quot;");
                break;
            default:
                out.push_back(Ch);
                break;
        }
    }
}

bool ReadI32Le(const std::uint8_t* bytes, std::size_t len, std::size_t offset, std::int32_t& out)
{
    if (bytes == nullptr || offset + sizeof(std::int32_t) > len)
    {
        return false;
    }

    std::memcpy(&out, bytes + offset, sizeof(std::int32_t));
    return true;
}

bool ReadI64Le(const std::uint8_t* bytes, std::size_t len, std::size_t offset, std::int64_t& out)
{
    if (bytes == nullptr || offset + sizeof(std::int64_t) > len)
    {
        return false;
    }

    std::memcpy(&out, bytes + offset, sizeof(std::int64_t));
    return true;
}

bool ReadSliceRef(
    const std::uint8_t* bytes, std::size_t len, std::size_t offset, std::int32_t& valueOffset, std::int32_t& valueLen)
{
    return ReadI32Le(bytes, len, offset, valueOffset) && ReadI32Le(bytes, len, offset + sizeof(std::int32_t), valueLen);
}

bool TryReadI32Advance(const std::uint8_t* bytes, std::size_t len, std::size_t& offset, std::int32_t& out)
{
    if (!ReadI32Le(bytes, len, offset, out))
    {
        return false;
    }

    offset += sizeof(std::int32_t);
    return true;
}

bool SkipBytes(std::size_t& offset, std::size_t len, std::size_t count)
{
    if (offset + count > len)
    {
        return false;
    }

    offset += count;
    return true;
}

void BeginPanel(const char* title)
{
    t_lastHtml.clear();
    t_lastHtml.reserve(1024);
    AppendLiteral(t_lastHtml, "<section class=\"aot-panel\"><div class=\"aot-panel__header\"><strong>");
    AppendLiteral(t_lastHtml, title);
    AppendLiteral(t_lastHtml, "</strong></div><div class=\"aot-panel__body\">");
}

void EndPanel()
{
    AppendLiteral(t_lastHtml, "</div></section>");
}

void AppendBlobSlice(
    std::string& out, const std::uint8_t* blob, std::size_t blobLen, std::int32_t valueOffset, std::int32_t valueLen)
{
    if (blob == nullptr || valueOffset < 0 || valueLen <= 0)
    {
        return;
    }

    const std::size_t SliceOffset = static_cast<std::size_t>(valueOffset);
    const std::size_t SliceLen = static_cast<std::size_t>(valueLen);
    if (SliceOffset + SliceLen > blobLen)
    {
        return;
    }

    AppendEscapedAscii(out, blob + SliceOffset, SliceLen);
}

int RenderArticleDetailHtml(const std::uint8_t* payload, std::uint32_t payloadLen)
{
    FsusBlog::Pod::ParsedArticleDetail parsed{};
    if (payload == nullptr || payloadLen == 0
        || !FsusBlog::Pod::ParseArticleDetailPayload(payload, payloadLen, &parsed))
    {
        SetError("payload_invalid");
        return 0;
    }

    t_lastHtml.clear();
    t_lastHtml.reserve(512);
    AppendLiteral(t_lastHtml, "<article class=\"aot-panel\" data-aot-view=\"article-detail\">");
    AppendLiteral(t_lastHtml, "<header class=\"aot-panel__header\"><h2>");
    AppendBlobSlice(t_lastHtml, parsed.payload_ptr, parsed.payload_len, parsed.title.offset, parsed.title.length);
    AppendLiteral(t_lastHtml, "</h2></header><section class=\"aot-panel__body\">");
    AppendLiteral(t_lastHtml, "<p class=\"meta\">#");
    AppendInt(t_lastHtml, parsed.article_id);
    AppendLiteral(t_lastHtml, " · ");
    AppendBlobSlice(
        t_lastHtml, parsed.payload_ptr, parsed.payload_len, parsed.category_name.offset, parsed.category_name.length);
    AppendLiteral(t_lastHtml, " · views ");
    AppendInt(t_lastHtml, parsed.views);
    AppendLiteral(t_lastHtml, "</p>");
    AppendLiteral(t_lastHtml, "<button class=\"aot-action-button\" data-aot-action=\"force-binary\">binary</button>");
    AppendLiteral(t_lastHtml, "</section></article>");
    SetError(nullptr);
    return 1;
}

int RenderArticleListHtml(const std::uint8_t* payload, std::uint32_t payloadLen)
{
    FsusBlog::AedsWire::ArticleListPayloadView view{};
    if (!FsusBlog::AedsWire::ValidateArticleListPayload(payload, payloadLen, view))
    {
        SetError("article_list_payload_invalid");
        return 0;
    }
    const auto total = view.total;
    const auto count = view.count;
    const auto* blob = view.blob;
    const auto blobLen = view.blobLength;
    const auto* records = view.records;

    t_lastHtml.clear();
    t_lastHtml.reserve(4096);
    AppendLiteral(t_lastHtml, "<section class=\"flex flex-col gap-12 sm:gap-20\" data-aot-view=\"article-list\">");

    const int RenderLimit = count > 12 ? 12 : count;
    for (int i = 0; i < count; ++i)
    {
        if (i >= RenderLimit)
        {
            continue;
        }

        const std::uint8_t* pod = records + static_cast<std::size_t>(i) * KArticleListRecordSize;
        std::int32_t id = 0;
        std::memcpy(&id, pod + 0, sizeof(std::int32_t));

        std::int32_t categoryOffset = 0;
        std::int32_t categoryLen = 0;
        std::int32_t titleOffset = 0;
        std::int32_t titleLen = 0;
        std::int32_t summaryOffset = 0;
        std::int32_t summaryLen = 0;
        ReadSliceRef(pod, KArticleListRecordSize, FsusBlog::AedsWire::ArticleListCategoryNameOffset, categoryOffset, categoryLen);
        ReadSliceRef(pod, KArticleListRecordSize, FsusBlog::AedsWire::ArticleListTitleOffset, titleOffset, titleLen);
        ReadSliceRef(pod, KArticleListRecordSize, FsusBlog::AedsWire::ArticleListSummaryOffset, summaryOffset, summaryLen);

        AppendLiteral(t_lastHtml,
                      "<article class=\"group flex flex-col items-start gap-3 sm:gap-4 subpixel-antialiased border-b "
                      "border-zinc-100 pb-12 sm:pb-16\">");
        AppendLiteral(t_lastHtml,
                      "<div class=\"flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium "
                      "tracking-wider text-zinc-400 uppercase\">");
        AppendLiteral(t_lastHtml, "<span class=\"text-zinc-600\">");
        AppendBlobSlice(t_lastHtml, blob, static_cast<std::size_t>(blobLen), categoryOffset, categoryLen);
        AppendLiteral(t_lastHtml, "</span></div>");

        AppendLiteral(t_lastHtml,
                      "<h2 class=\"text-xl sm:text-2xl font-bold text-zinc-950 leading-snug transition-colors "
                      "duration-300 group-hover:text-zinc-500\">");
        AppendLiteral(t_lastHtml, "<a class=\"block\" href=\"/article/");
        AppendInt(t_lastHtml, id);
        AppendLiteral(t_lastHtml, "\" data-aot-action=\"open-article\" data-aot-id=\"");
        AppendInt(t_lastHtml, id);
        AppendLiteral(t_lastHtml, "\">");
        AppendBlobSlice(t_lastHtml, blob, static_cast<std::size_t>(blobLen), titleOffset, titleLen);
        AppendLiteral(t_lastHtml, "</a></h2>");

        AppendLiteral(t_lastHtml,
                      "<p class=\"text-sm sm:text-base text-zinc-600 leading-relaxed sm:leading-loose line-clamp-3\">");
        AppendBlobSlice(t_lastHtml, blob, static_cast<std::size_t>(blobLen), summaryOffset, summaryLen);
        AppendLiteral(t_lastHtml, "</p>");

        AppendLiteral(t_lastHtml,
                      "<a class=\"mt-2 text-[11px] sm:text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 "
                      "hover:text-zinc-500 transition-colors flex items-center gap-2 py-2 -ml-0.5\" href=\"/article/");
        AppendInt(t_lastHtml, id);
        AppendLiteral(t_lastHtml, "\" data-aot-action=\"open-article\" data-aot-id=\"");
        AppendInt(t_lastHtml, id);
        AppendLiteral(t_lastHtml, "\">阅读<span aria-hidden=\"true\">→</span></a></article>");
    }

    if (count <= 0)
    {
        AppendLiteral(t_lastHtml, "<section class=\"py-16 text-sm text-zinc-500\">暂无文章。</section>");
    }

    AppendLiteral(
        t_lastHtml,
        "<nav class=\"pt-2 flex justify-between items-center border-t border-zinc-100\" aria-label=\"文章分页\">");
    AppendLiteral(t_lastHtml,
                  "<button class=\"text-xs font-bold tracking-[0.2em] uppercase transition-colors text-zinc-400 "
                  "hover:text-zinc-950 p-4 -ml-4\" data-aot-action=\"page-prev\">上一页</button>");
    AppendLiteral(t_lastHtml, "<span class=\"text-xs font-mono font-medium text-zinc-300 tabular-nums\">");
    AppendInt(t_lastHtml, count);
    AppendLiteral(t_lastHtml, " / ");
    AppendInt(t_lastHtml, total);
    AppendLiteral(t_lastHtml, "</span>");
    AppendLiteral(t_lastHtml,
                  "<button class=\"text-xs font-bold tracking-[0.2em] uppercase transition-colors text-zinc-400 "
                  "hover:text-zinc-950 p-4 -mr-4\" data-aot-action=\"page-next\">下一页</button>");
    AppendLiteral(t_lastHtml, "</nav></section>");
    SetError(nullptr);
    return 1;
}

int RenderCommentCursorHtml(const std::uint8_t* payload, std::uint32_t payloadLen, bool includeArticle)
{
    if (payload == nullptr || payloadLen < 13u)
    {
        SetError("comment_payload_invalid");
        return 0;
    }

    std::size_t cursor = 0u;
    std::int64_t nextCursor = 0;
    if (!ReadI64Le(payload, payloadLen, cursor, nextCursor))
    {
        SetError("comment_next_cursor_invalid");
        return 0;
    }
    cursor += 8u;

    if (cursor + 1u > payloadLen)
    {
        SetError("comment_has_more_invalid");
        return 0;
    }
    const std::uint8_t HasMore = payload[cursor++];

    std::int32_t count = 0;
    if (!TryReadI32Advance(payload, payloadLen, cursor, count) || count < 0)
    {
        SetError("comment_count_invalid");
        return 0;
    }

    BeginPanel(includeArticle ? "AOT My Comments" : "AOT Article Comments");
    AppendLiteral(t_lastHtml, "<p class=\"aot-meta\">count=");
    AppendInt(t_lastHtml, count);
    AppendLiteral(t_lastHtml, " hasMore=");
    AppendInt(t_lastHtml, HasMore);
    AppendLiteral(t_lastHtml, " next=");
    AppendInt(t_lastHtml, nextCursor);
    AppendLiteral(t_lastHtml, "</p><ol class=\"aot-list\">");

    for (int i = 0; i < count; ++i)
    {
        const std::size_t PodSize = includeArticle ? KUserCommentPodSize : KCommentItemPodSize;
        if (cursor + PodSize > payloadLen)
        {
            SetError("comment_pod_overflow");
            return 0;
        }
        const std::uint8_t* pod = payload + cursor;
        cursor += PodSize;

        std::int32_t blobLen = 0;
        if (!TryReadI32Advance(payload, payloadLen, cursor, blobLen) || blobLen < 0)
        {
            SetError("comment_blob_len_invalid");
            return 0;
        }
        if (cursor + static_cast<std::size_t>(blobLen) > payloadLen)
        {
            SetError("comment_blob_overflow");
            return 0;
        }
        const std::uint8_t* blob = payload + cursor;
        cursor += static_cast<std::size_t>(blobLen);

        std::int32_t contentOffset = 0;
        std::int32_t contentLen = 0;
        const std::size_t ContentRefOffset = includeArticle ? 20u : 16u;
        std::memcpy(&contentOffset, pod + ContentRefOffset, sizeof(std::int32_t));
        std::memcpy(&contentLen, pod + ContentRefOffset + 4u, sizeof(std::int32_t));

        AppendLiteral(t_lastHtml, "<li class=\"aot-item\"><strong>");
        if (includeArticle)
        {
            AppendLiteral(t_lastHtml, "#");
            std::int32_t articleId = 0;
            std::memcpy(&articleId, pod + 8, sizeof(std::int32_t));
            AppendInt(t_lastHtml, articleId);
            AppendLiteral(t_lastHtml, " ");
            AppendEscapedAscii(t_lastHtml, pod + 28, 256);
        }
        else
        {
            AppendEscapedAscii(t_lastHtml, pod + 16, 64);
        }
        AppendLiteral(t_lastHtml, "</strong><p>");
        if (contentOffset >= 0 && contentLen > 0
            && static_cast<std::size_t>(contentOffset) + static_cast<std::size_t>(contentLen)
                   <= static_cast<std::size_t>(blobLen))
        {
            AppendEscapedAscii(t_lastHtml, blob + contentOffset, static_cast<std::size_t>(contentLen));
        }
        AppendLiteral(t_lastHtml, "</p></li>");
    }

    AppendLiteral(t_lastHtml, "</ol>");
    EndPanel();
    SetError(nullptr);
    return 1;
}

int RenderAdminStatsHtml(const std::uint8_t* payload, std::uint32_t payloadLen)
{
    if (payload == nullptr || payloadLen < KSiteStatsPodSize + 4u + 4u + 4u)
    {
        SetError("stats_payload_invalid");
        return 0;
    }

    BeginPanel("AOT Admin Stats");
    std::int32_t totalArticles = 0;
    std::int32_t totalComments = 0;
    std::int32_t totalReads = 0;
    std::memcpy(&totalArticles, payload + 0, sizeof(std::int32_t));
    std::memcpy(&totalComments, payload + 4, sizeof(std::int32_t));
    std::memcpy(&totalReads, payload + 12, sizeof(std::int32_t));

    AppendLiteral(t_lastHtml, "<div class=\"aot-metrics\">");
    AppendLiteral(t_lastHtml, "<span>articles:");
    AppendInt(t_lastHtml, totalArticles);
    AppendLiteral(t_lastHtml, "</span><span> comments:");
    AppendInt(t_lastHtml, totalComments);
    AppendLiteral(t_lastHtml, "</span><span> reads:");
    AppendInt(t_lastHtml, totalReads);
    AppendLiteral(t_lastHtml, "</span></div>");

    std::size_t cursor = KSiteStatsPodSize;
    std::int32_t blobLen = 0;
    if (!TryReadI32Advance(payload, payloadLen, cursor, blobLen) || blobLen < 0
        || cursor + static_cast<std::size_t>(blobLen) > payloadLen)
    {
        SetError("stats_blob_invalid");
        return 0;
    }
    const std::uint8_t* blob = payload + cursor;
    cursor += static_cast<std::size_t>(blobLen);

    std::int32_t popularCount = 0;
    if (!TryReadI32Advance(payload, payloadLen, cursor, popularCount) || popularCount < 0)
    {
        SetError("stats_popular_count_invalid");
        return 0;
    }

    AppendLiteral(t_lastHtml, "<h4>popular</h4><ul class=\"aot-list\">");
    const int PopularLimit = popularCount > 6 ? 6 : popularCount;
    for (int i = 0; i < popularCount; ++i)
    {
        if (cursor + KCompactPopularRecordSize > payloadLen)
        {
            SetError("stats_popular_overflow");
            return 0;
        }
        const std::uint8_t* pod = payload + cursor;
        cursor += KCompactPopularRecordSize;
        if (i >= PopularLimit)
        {
            continue;
        }
        std::int32_t views = 0;
        std::memcpy(&views, pod + 4, sizeof(std::int32_t));
        std::int32_t titleOffset = 0;
        std::int32_t titleLen = 0;
        ReadSliceRef(pod, KCompactPopularRecordSize, 8u, titleOffset, titleLen);
        AppendLiteral(t_lastHtml, "<li class=\"aot-item\">");
        AppendBlobSlice(t_lastHtml, blob, static_cast<std::size_t>(blobLen), titleOffset, titleLen);
        AppendLiteral(t_lastHtml, " <em>");
        AppendInt(t_lastHtml, views);
        AppendLiteral(t_lastHtml, "</em></li>");
    }
    AppendLiteral(t_lastHtml, "</ul>");

    std::int32_t recentCount = 0;
    if (!TryReadI32Advance(payload, payloadLen, cursor, recentCount) || recentCount < 0)
    {
        SetError("stats_recent_count_invalid");
        return 0;
    }
    for (int i = 0; i < recentCount; ++i)
    {
        if (cursor + KRecentCommentRecordSize > payloadLen)
        {
            SetError("stats_recent_overflow");
            return 0;
        }
        cursor += KRecentCommentRecordSize;
    }

    std::int32_t regionCount = 0;
    if (!TryReadI32Advance(payload, payloadLen, cursor, regionCount) || regionCount < 0)
    {
        SetError("stats_region_count_invalid");
        return 0;
    }

    AppendLiteral(t_lastHtml, "<h4>regions</h4><ul class=\"aot-list\">");
    const int RegionLimit = regionCount > 5 ? 5 : regionCount;
    for (int i = 0; i < regionCount; ++i)
    {
        if (cursor + KRegionDistributionRecordSize > payloadLen)
        {
            SetError("stats_region_overflow");
            return 0;
        }
        const std::uint8_t* pod = payload + cursor;
        cursor += KRegionDistributionRecordSize;
        if (i >= RegionLimit)
        {
            continue;
        }
        std::int32_t regionCountItem = 0;
        std::memcpy(&regionCountItem, pod + 0, sizeof(std::int32_t));
        std::int32_t regionOffset = 0;
        std::int32_t regionLen = 0;
        ReadSliceRef(pod, KRegionDistributionRecordSize, 4u, regionOffset, regionLen);
        AppendLiteral(t_lastHtml, "<li class=\"aot-item\">");
        AppendBlobSlice(t_lastHtml, blob, static_cast<std::size_t>(blobLen), regionOffset, regionLen);
        AppendLiteral(t_lastHtml, " <em>");
        AppendInt(t_lastHtml, regionCountItem);
        AppendLiteral(t_lastHtml, "</em></li>");
    }
    AppendLiteral(t_lastHtml, "</ul>");
    EndPanel();
    SetError(nullptr);
    return 1;
}

int RenderHotArticlesHtml(const std::uint8_t* payload, std::uint32_t payloadLen)
{
    if (payload == nullptr || payloadLen < 8u)
    {
        SetError("article_hot_payload_invalid");
        return 0;
    }

    std::int32_t count = 0;
    std::int32_t blobLen = 0;
    if (!ReadI32Le(payload, payloadLen, 0, count) || !ReadI32Le(payload, payloadLen, 4, blobLen) || count < 0
        || blobLen < 0)
    {
        SetError("article_hot_count_invalid");
        return 0;
    }

    std::size_t cursor = 8u;
    if (cursor + static_cast<std::size_t>(blobLen) > payloadLen)
    {
        SetError("article_hot_blob_overflow");
        return 0;
    }
    const std::uint8_t* blob = payload + cursor;
    cursor += static_cast<std::size_t>(blobLen);
    if (cursor + static_cast<std::size_t>(count) * KCompactPopularRecordSize > payloadLen)
    {
        SetError("article_hot_records_overflow");
        return 0;
    }
    BeginPanel("AOT Hot Articles");
    AppendLiteral(t_lastHtml, "<ol class=\"aot-list\">");
    for (int i = 0; i < count; ++i)
    {
        const std::uint8_t* pod = payload + cursor;
        cursor += KCompactPopularRecordSize;

        std::int32_t id = 0;
        std::int32_t views = 0;
        std::memcpy(&id, pod + 0, sizeof(std::int32_t));
        std::memcpy(&views, pod + 4, sizeof(std::int32_t));
        std::int32_t titleOffset = 0;
        std::int32_t titleLen = 0;
        ReadSliceRef(pod, KCompactPopularRecordSize, 8u, titleOffset, titleLen);
        AppendLiteral(t_lastHtml, "<li class=\"aot-item\"><a data-aot-action=\"open-article\" data-aot-id=\"");
        AppendInt(t_lastHtml, id);
        AppendLiteral(t_lastHtml, "\">");
        AppendBlobSlice(t_lastHtml, blob, static_cast<std::size_t>(blobLen), titleOffset, titleLen);
        AppendLiteral(t_lastHtml, "</a><em>");
        AppendInt(t_lastHtml, views);
        AppendLiteral(t_lastHtml, "</em></li>");
    }
    AppendLiteral(t_lastHtml, "</ol>");
    EndPanel();
    SetError(nullptr);
    return 1;
}

int RenderGenericHtml(std::uint16_t frameType, std::uint32_t payloadLen)
{
    t_lastHtml.clear();
    t_lastHtml.reserve(256);
    AppendLiteral(t_lastHtml, "<section class=\"aot-frame\" data-aot-frame=\"");
    AppendU32(t_lastHtml, frameType);
    AppendLiteral(t_lastHtml, "\"><p>frame:");
    AppendU32(t_lastHtml, frameType);
    AppendLiteral(t_lastHtml, " payload:");
    AppendU32(t_lastHtml, payloadLen);
    AppendLiteral(t_lastHtml, "</p></section>");
    SetError(nullptr);
    return 1;
}

} // namespace

extern "C"
{
    int decode_aeds(const std::uint8_t* data, int len)
    {
        AdvanceHandleEpoch();
        if (data == nullptr || len <= 0)
        {
            SetError("invalid_input");
            t_errorCode = static_cast<std::uint8_t>(FsusBlog::Aeds::ErrorCode::InvalidInput);
            return 0;
        }

        const FsusBlog::Aeds::DecodeResult Result = FsusBlog::Aeds::DecodeFrame(data, static_cast<std::size_t>(len));
        if (!Result.ok)
        {
            t_errorCode = static_cast<std::uint8_t>(Result.error_code);
            SetError(Result.error);
            return 0;
        }

        t_errorCode = static_cast<std::uint8_t>(FsusBlog::Aeds::ErrorCode::None);
        SetError(nullptr);
        t_payloadPtr = Result.payload_ptr;
        t_payloadLen = Result.payload_len;
        t_frameType = Result.frame_type;
        t_payloadHandleToken = t_handleEpoch;
        return 1;
    }

    std::uint64_t get_last_payload_token()
    {
        return t_payloadHandleToken;
    }

    std::uintptr_t get_last_payload_ptr(std::uint64_t token)
    {
        if (token == 0U || token != t_payloadHandleToken || t_payloadPtr == nullptr)
        {
            return 0;
        }

        return reinterpret_cast<std::uintptr_t>(t_payloadPtr);
    }

    std::uint32_t get_last_payload_len(std::uint64_t token)
    {
        return token != 0U && token == t_payloadHandleToken ? t_payloadLen : 0U;
    }

    std::uint16_t get_last_frame_type(std::uint64_t token)
    {
        return token != 0U && token == t_payloadHandleToken ? t_frameType : 0U;
    }

    const char* get_last_error_ptr()
    {
        return t_error.data();
    }

    int get_last_error_len()
    {
        return static_cast<int>(std::strlen(t_error.data()));
    }

    std::uint8_t get_last_error_code()
    {
        return t_errorCode;
    }

    std::uint64_t reserve_io_buffer(int size)
    {
        AdvanceHandleEpoch();
        if (size <= 0)
        {
            return 0;
        }

        if (!t_ioArena.empty())
        {
            std::fill(t_ioArena.begin(), t_ioArena.end(), static_cast<std::uint8_t>(0));
            ++t_arenaClearCount;
        }
        const auto Requested = static_cast<std::size_t>(size);
        const auto PreviousCapacity = t_ioArena.capacity();
        if (Requested > PreviousCapacity)
        {
            t_ioArena.reserve(Requested);
            ++t_arenaReallocationCount;
        }
        t_ioArena.resize(Requested);
        t_ioSize = static_cast<std::uint32_t>(Requested);
        t_ioHandleToken = t_handleEpoch;
        return t_ioHandleToken;
    }

    int decode_io_buffer(std::uint64_t token, int len)
    {
        if (token == 0U || token != t_ioHandleToken || len <= 0 || static_cast<std::uint32_t>(len) > t_ioSize
            || t_ioArena.empty())
        {
            return decode_aeds(nullptr, 0);
        }

        return decode_aeds(t_ioArena.data(), len);
    }

    void clear_io_buffer(int releaseMemory)
    {
        AdvanceHandleEpoch();
        if (!t_ioArena.empty())
        {
            std::fill(t_ioArena.begin(), t_ioArena.end(), static_cast<std::uint8_t>(0));
            ++t_arenaClearCount;
        }
        t_ioSize = 0;

        if (releaseMemory != 0)
        {
            std::vector<std::uint8_t>().swap(t_ioArena);
        }
        else
        {
            t_ioArena.clear();
        }
    }

    std::uintptr_t get_io_buffer_ptr(std::uint64_t token)
    {
        return token == 0U || token != t_ioHandleToken || t_ioArena.empty()
                   ? 0
                   : reinterpret_cast<std::uintptr_t>(t_ioArena.data());
    }

    std::uint32_t get_io_buffer_size(std::uint64_t token)
    {
        return token != 0U && token == t_ioHandleToken ? t_ioSize : 0U;
    }

    std::uint32_t get_io_buffer_capacity()
    {
        return static_cast<std::uint32_t>(t_ioArena.capacity());
    }

    std::uint32_t get_arena_reallocation_count()
    {
        return t_arenaReallocationCount;
    }

    std::uint32_t get_arena_clear_count()
    {
        return t_arenaClearCount;
    }

    int render_view(std::uint64_t token)
    {
        if (token == 0U || token != t_payloadHandleToken || t_payloadPtr == nullptr)
        {
            SetError("payload_handle_expired");
            return 0;
        }
        switch (t_frameType)
        {
            case 1u:
            case 4u:
                return RenderArticleListHtml(t_payloadPtr, t_payloadLen);
            case 2u:
                return RenderArticleDetailHtml(t_payloadPtr, t_payloadLen);
            case 3u:
                return RenderHotArticlesHtml(t_payloadPtr, t_payloadLen);
            case 5u:
                return RenderCommentCursorHtml(t_payloadPtr, t_payloadLen, false);
            case 6u:
                return RenderCommentCursorHtml(t_payloadPtr, t_payloadLen, true);
            case 7u:
                return RenderAdminStatsHtml(t_payloadPtr, t_payloadLen);
            default:
                return RenderGenericHtml(t_frameType, t_payloadLen);
        }
    }

    std::uint32_t get_last_html_ptr()
    {
        return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(t_lastHtml.data()));
    }

    std::uint32_t get_last_html_len()
    {
        return static_cast<std::uint32_t>(t_lastHtml.size());
    }

    int handle_event(std::int32_t actionId, std::int32_t value)
    {
        t_lastHtml.clear();
        t_lastHtml.reserve(128);
        AppendLiteral(t_lastHtml, "<span class=\"aot-event\">action=");
        AppendInt(t_lastHtml, actionId);
        AppendLiteral(t_lastHtml, " value=");
        AppendInt(t_lastHtml, value);
        AppendLiteral(t_lastHtml, "</span>");
        SetError(nullptr);
        return 1;
    }
}
