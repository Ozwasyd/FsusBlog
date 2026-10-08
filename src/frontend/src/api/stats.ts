import { requestBinaryOnly } from '@/composition/binaryTransport';
import type {
    AdminStatsOverview,
    AdminStatsQuery,
    RecentCommentStatItem,
    RegionStatItem,
    StatsSummary,
    TrashClearResponse
} from '@/contracts/binaryApi';

import { FrameType } from '@wasm/protocol/frame';

import type { ApiRequestConfig } from './requestConfig';

export type { AdminStatsOverview, AdminStatsQuery, RecentCommentStatItem, RegionStatItem, StatsSummary, TrashClearResponse } from '@/contracts/binaryApi';

export const getAdminStatsQuery = (config?: ApiRequestConfig) =>
    requestBinaryOnly<AdminStatsQuery>({
        binaryRoute: { operationId: 'binary_get_stats' },
        frameType: FrameType.AdminStats,
        signal: config?.signal
    });

export const getSiteStatsOverview = async (config?: ApiRequestConfig) =>
    (await getAdminStatsQuery(config)).overview;

export const getRecentCommentStats = (config?: ApiRequestConfig) =>
    requestBinaryOnly<RecentCommentStatItem[]>({
        binaryRoute: { operationId: 'binary_get_stats_recent_comments' },
        frameType: FrameType.RecentCommentStats,
        signal: config?.signal
    });

export const getRegionStats = (config?: ApiRequestConfig) =>
    requestBinaryOnly<RegionStatItem[]>({
        binaryRoute: { operationId: 'binary_get_stats_regions' },
        frameType: FrameType.RegionStats,
        signal: config?.signal
    });
