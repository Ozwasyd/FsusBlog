import type { SiteStats } from '@/api/stats';
import { BinaryReader, readByte, readFixedUtf8, readInt32, readInt64Number, readSliceRef, readSliceText } from './reader';
import { POPULAR_ARTICLE_POD_SIZE, RECENT_COMMENT_POD_SIZE, REGION_DISTRIBUTION_POD_SIZE, SITE_STATS_POD_SIZE } from './types';

export function mapSiteStatsFromPodPayload(payload: Uint8Array): SiteStats {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(SITE_STATS_POD_SIZE);

  const popularCount = reader.readInt32();
  if (popularCount < 0) throw new Error('site_stats_popular_count_invalid');
  const popularArticles = [];
  for (let i = 0; i < popularCount; i++) {
    const itemPod = reader.readSpan(POPULAR_ARTICLE_POD_SIZE);
    popularArticles.push({
      id: readInt32(itemPod, 0),
      title: readFixedUtf8(itemPod, 8, 256),
      views: readInt32(itemPod, 4)
    });
  }

  const recentCount = reader.readInt32();
  if (recentCount < 0) throw new Error('site_stats_recent_count_invalid');
  const recentComments = [];
  for (let i = 0; i < recentCount; i++) {
    const itemPod = reader.readSpan(RECENT_COMMENT_POD_SIZE);
    const blob = reader.readBlob();
    recentComments.push({
      userId: readByte(itemPod, 4) === 1 ? readInt32(itemPod, 0) : null,
      userName: readFixedUtf8(itemPod, 16, 64),
      content: readSliceText(blob, readSliceRef(itemPod, 80)),
      createTime: new Date(readInt64Number(itemPod, 8)).toISOString()
    });
  }

  const regionCount = reader.readInt32();
  if (regionCount < 0) throw new Error('site_stats_region_count_invalid');
  const regionDistributions = [];
  for (let i = 0; i < regionCount; i++) {
    const itemPod = reader.readSpan(REGION_DISTRIBUTION_POD_SIZE);
    regionDistributions.push({
      count: readInt32(itemPod, 0),
      region: readFixedUtf8(itemPod, 4, 128)
    });
  }

  return {
    totalArticles: readInt32(pod, 0),
    totalComments: readInt32(pod, 4),
    trashCount: readInt32(pod, 8),
    totalVisits: readInt32(pod, 12),
    registeredVisits: readInt32(pod, 16),
    anonymousVisits: readInt32(pod, 20),
    popularArticles,
    recentComments,
    regionDistributions
  };
}
