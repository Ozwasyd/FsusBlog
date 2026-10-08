// Generated from src/shared/Contracts/Validation/aeds-protocol.json. Run npm run generate:aeds-protocol from src/frontend.
#pragma once
#include <cstddef>
#include <cstdint>
namespace FsusBlog::AedsWire
{
inline constexpr std::int32_t ArticleSearchMagic = 877810502;
inline constexpr std::int32_t ArticleSearchVersion = 4;
inline constexpr std::int32_t ArticleSearchHeaderBytes = 24;
inline constexpr std::int32_t ArticleSearchRecordBytes = 76;
inline constexpr std::int32_t ArticleSearchTagRecordBytes = 12;
inline constexpr std::size_t ArticleSearchIdOffset = 0u;
inline constexpr std::size_t ArticleSearchViewsOffset = 4u;
inline constexpr std::size_t ArticleSearchCreateTimeUnixMsOffset = 8u;
inline constexpr std::size_t ArticleSearchCategoryIdOffset = 16u;
inline constexpr std::size_t ArticleSearchCategoryNameOffset = 20u;
inline constexpr std::size_t ArticleSearchTitleOffset = 28u;
inline constexpr std::size_t ArticleSearchSummaryOffset = 36u;
inline constexpr std::size_t ArticleSearchTagStartOffset = 44u;
inline constexpr std::size_t ArticleSearchTagCountOffset = 48u;
inline constexpr std::size_t ArticleSearchCurrentRevisionIdOffset = 52u;
inline constexpr std::size_t ArticleSearchRevisionNoOffset = 60u;
inline constexpr std::size_t ArticleSearchCurrentPublicationIdOffset = 64u;
inline constexpr std::size_t ArticleSearchPublicationNoOffset = 72u;
}
