// Generated from src/shared/Contracts/Validation/aeds-protocol.json. Run npm run generate:aeds-protocol from src/frontend.
#pragma once
#include <cstddef>
#include <cstdint>
namespace FsusBlog::AedsWire
{
inline constexpr std::int32_t ArticleListCursorMagic = 1095979078;
inline constexpr std::int32_t ArticleListCursorVersion = 2;
inline constexpr std::int32_t ArticleListRecordBytes = 100;
inline constexpr std::int32_t ArticleListTagRecordBytes = 12;
inline constexpr std::size_t ArticleListIdOffset = 0u;
inline constexpr std::size_t ArticleListViewsOffset = 4u;
inline constexpr std::size_t ArticleListCreateTimeUnixMsOffset = 8u;
inline constexpr std::size_t ArticleListCategoryIdOffset = 16u;
inline constexpr std::size_t ArticleListCategoryNameOffset = 20u;
inline constexpr std::size_t ArticleListTitleOffset = 28u;
inline constexpr std::size_t ArticleListSummaryOffset = 36u;
inline constexpr std::size_t ArticleListTagStartOffset = 44u;
inline constexpr std::size_t ArticleListTagCountOffset = 48u;
inline constexpr std::size_t ArticleListIsDeletedOffset = 52u;
inline constexpr std::size_t ArticleListHasIsDeletedOffset = 53u;
inline constexpr std::size_t ArticleListReserved0Offset = 54u;
inline constexpr std::size_t ArticleListReserved1Offset = 55u;
inline constexpr std::size_t ArticleListStatusOffset = 56u;
inline constexpr std::size_t ArticleListScheduledPublishAtUnixMsOffset = 60u;
inline constexpr std::size_t ArticleListPublishedAtUnixMsOffset = 68u;
inline constexpr std::size_t ArticleListCurrentRevisionIdOffset = 76u;
inline constexpr std::size_t ArticleListRevisionNoOffset = 84u;
inline constexpr std::size_t ArticleListCurrentPublicationIdOffset = 88u;
inline constexpr std::size_t ArticleListPublicationNoOffset = 96u;
}
