import type { AdminStatsOverview } from '@/api/stats';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { BinaryReader, readFixedUtf8, readInt32 } from './reader';
import { POPULAR_ARTICLE_POD_SIZE, SITE_STATS_POD_SIZE } from './types';

export function mapSiteStatsFromPodPayload(payload: Uint8Array): AdminStatsOverview {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(SITE_STATS_POD_SIZE);

  const popularCount = reader.readInt32();
  if (popularCount < 0) throw createAppError(AppErrorCode.ProtocolFailure, 'site_stats_popular_count_invalid');
  const popularArticles = [];
  for (let i = 0; i < popularCount; i++) {
    const itemPod = reader.readSpan(POPULAR_ARTICLE_POD_SIZE);
    popularArticles.push({
      id: readInt32(itemPod, 0),
      title: readFixedUtf8(itemPod, 8, 256),
      views: readInt32(itemPod, 4)
    });
  }

  return {
    summary: {
      totalArticles: readInt32(pod, 0),
      totalComments: readInt32(pod, 4),
      trashCount: readInt32(pod, 8),
      totalVisits: readInt32(pod, 12),
      registeredVisits: readInt32(pod, 16),
      anonymousVisits: readInt32(pod, 20)
    },
    popularArticles
  };
}
