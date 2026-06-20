import type { AdminStatsOverview, AdminStatsQuery, RecentCommentStatItem, RegionStatItem } from '@/api/stats';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { BinaryReader, readInt32, readIsoDate64, readSliceRef, readSliceText } from './reader';
import { SITE_STATS_POD_SIZE } from './types';

export function mapSiteStatsFromPodPayload(payload: Uint8Array): AdminStatsQuery {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(SITE_STATS_POD_SIZE);
  const blob = reader.readBlob();

  const popularCount = reader.readInt32();
  if (popularCount < 0) throw createAppError(AppErrorCode.ProtocolFailure, 'site_stats_popular_count_invalid');
  const popularArticles = [];
  for (let i = 0; i < popularCount; i++) {
    popularArticles.push(readPopularArticleStat(reader.readSpan(16), blob));
  }

  const recentCount = reader.readInt32();
  if (recentCount < 0) throw createAppError(AppErrorCode.ProtocolFailure, 'site_stats_recent_count_invalid');
  const recentComments: RecentCommentStatItem[] = [];
  for (let i = 0; i < recentCount; i++) {
    recentComments.push(readRecentCommentStat(reader.readSpan(32), blob));
  }

  const regionCount = reader.readInt32();
  if (regionCount < 0) throw createAppError(AppErrorCode.ProtocolFailure, 'site_stats_region_count_invalid');
  const regions: RegionStatItem[] = [];
  for (let i = 0; i < regionCount; i++) {
    regions.push(readRegionStat(reader.readSpan(12), blob));
  }

  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'site_stats_trailing_payload_invalid');
  }

  return {
    overview: {
      summary: {
        totalArticles: readInt32(pod, 0),
        totalComments: readInt32(pod, 4),
        trashCount: readInt32(pod, 8),
        totalReads: readInt32(pod, 12),
        humanVerifiedReads: readInt32(pod, 16),
        uniqueViewerKeyEstimate: readInt32(pod, 20),
        articleReads: readInt32(pod, 24),
        siteReads: readInt32(pod, 28)
      },
      popularArticles
    },
    recentComments,
    regions
  };
}

export function mapRecentCommentsFromPodPayload(payload: Uint8Array): RecentCommentStatItem[] {
  const reader = new BinaryReader(payload);
  const count = reader.readInt32();
  if (count < 0) throw createAppError(AppErrorCode.ProtocolFailure, 'recent_comment_count_invalid');
  const blob = reader.readBlob();

  const comments: RecentCommentStatItem[] = [];
  for (let i = 0; i < count; i += 1) {
    comments.push(readRecentCommentStat(reader.readSpan(32), blob));
  }

  return comments;
}

export function mapRegionsFromPodPayload(payload: Uint8Array): RegionStatItem[] {
  const reader = new BinaryReader(payload);
  const count = reader.readInt32();
  if (count < 0) throw createAppError(AppErrorCode.ProtocolFailure, 'region_count_invalid');
  const blob = reader.readBlob();

  const regions: RegionStatItem[] = [];
  for (let i = 0; i < count; i += 1) {
    regions.push(readRegionStat(reader.readSpan(12), blob));
  }

  return regions;
}

function readPopularArticleStat(itemPod: Uint8Array, blob: Uint8Array): AdminStatsOverview['popularArticles'][number] {
  return {
    id: readInt32(itemPod, 0),
    views: readInt32(itemPod, 4),
    title: readSliceText(blob, readSliceRef(itemPod, 8))
  };
}

function readRecentCommentStat(pod: Uint8Array, blob: Uint8Array): RecentCommentStatItem {
  return {
    userId: (pod[4] ?? 0) === 1 ? readInt32(pod, 0) : null,
    createTime: readIsoDate64(pod, 8),
    userName: readSliceText(blob, readSliceRef(pod, 16)),
    content: readSliceText(blob, readSliceRef(pod, 24))
  };
}

function readRegionStat(pod: Uint8Array, blob: Uint8Array): RegionStatItem {
  return {
    count: readInt32(pod, 0),
    region: readSliceText(blob, readSliceRef(pod, 4))
  };
}
