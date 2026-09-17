// Generated from src/shared/Contracts/Validation/aeds-access-profiles.json. Do not edit.
#pragma once
#include <cstddef>
#include <cstdint>

namespace FsusBlog::AedsAccess
{
enum class ProfileId : std::uint8_t
{
    Unknown = 0,
    PublicArticleListCard = 1,
    PublicFilterArchiveItem = 2,
    NotificationArticlePreview = 3,
    ArticleSearchRankingCandidate = 4,
};

inline constexpr std::int32_t ArticleListCursorMagic = 1095979078;
inline constexpr std::size_t ArticleListTagRecordBytes = 12u;
inline constexpr std::size_t PublicCardCurrentRecordBytes = 100u;
inline constexpr std::size_t PublicCardLegacyRecordBytes = 76u;
inline constexpr std::size_t PublicCardFallbackRecordBytes = 56u;
inline constexpr std::size_t IdOffset = 0u;
inline constexpr std::size_t ViewsOffset = 4u;
inline constexpr std::size_t CreateTimeUnixMsOffset = 8u;
inline constexpr std::size_t CategoryIdOffset = 16u;
inline constexpr std::size_t CategoryNameOffset = 20u;
inline constexpr std::size_t TitleOffset = 28u;
inline constexpr std::size_t SummaryOffset = 36u;
inline constexpr std::size_t TagStartOffset = 44u;
inline constexpr std::size_t TagCountOffset = 48u;
inline constexpr std::size_t IsDeletedOffset = 52u;
inline constexpr std::size_t HasIsDeletedOffset = 53u;
inline constexpr std::size_t Reserved0Offset = 54u;
inline constexpr std::size_t Reserved1Offset = 55u;
inline constexpr std::size_t StatusOffset = 56u;
inline constexpr std::size_t ScheduledPublishAtUnixMsOffset = 60u;
inline constexpr std::size_t PublishedAtUnixMsOffset = 68u;
inline constexpr std::size_t CurrentRevisionIdOffset = 76u;
inline constexpr std::size_t RevisionNoOffset = 84u;
inline constexpr std::size_t CurrentPublicationIdOffset = 88u;
inline constexpr std::size_t PublicationNoOffset = 96u;
}
