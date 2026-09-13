// Generated from src/shared/Contracts/Validation/aeds-access-profiles.json. Do not edit.
export const AEDS_ACCESS_PROFILE = Object.freeze({
  publicArticleListCard: 'publicArticleListCard',
  publicFilterArchiveItem: 'publicFilterArchiveItem',
  notificationArticlePreview: 'notificationArticlePreview',
  articleSearchRankingCandidate: 'articleSearchRankingCandidate',
} as const)

export type AedsAccessProfileId = typeof AEDS_ACCESS_PROFILE[keyof typeof AEDS_ACCESS_PROFILE]

export const ARTICLE_LIST_ACCESS = Object.freeze({
  cursorMagic: 1095979078,
  cursorVersions: [2] as const,
  tagRecordBytes: 12,
  supportedPublicCardRecordBytes: [76, 100] as const,
  fallbackPublicCardRecordBytes: [56] as const,
  offsets: Object.freeze({
  "id": 0,
  "views": 4,
  "createTimeUnixMs": 8,
  "categoryId": 16,
  "categoryName": 20,
  "title": 28,
  "summary": 36,
  "tagStart": 44,
  "tagCount": 48,
  "isDeleted": 52,
  "hasIsDeleted": 53,
  "reserved0": 54,
  "reserved1": 55,
  "status": 56,
  "scheduledPublishAtUnixMs": 60,
  "publishedAtUnixMs": 68,
  "currentRevisionId": 76,
  "revisionNo": 84,
  "currentPublicationId": 88,
  "publicationNo": 96
})
})
