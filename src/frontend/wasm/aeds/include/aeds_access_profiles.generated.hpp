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

}
