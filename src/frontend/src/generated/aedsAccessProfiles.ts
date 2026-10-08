// Generated from src/shared/Contracts/Validation/aeds-access-profiles.json. Do not edit.
export const AEDS_ACCESS_PROFILE = Object.freeze({
  publicArticleListCard: 'publicArticleListCard',
  publicFilterArchiveItem: 'publicFilterArchiveItem',
  notificationArticlePreview: 'notificationArticlePreview',
  articleSearchRankingCandidate: 'articleSearchRankingCandidate',
} as const)

export type AedsAccessProfileId = typeof AEDS_ACCESS_PROFILE[keyof typeof AEDS_ACCESS_PROFILE]
