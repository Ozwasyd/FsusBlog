import { requestBinaryOnly } from '@/composition/binaryTransport';
import type {
    AdminStatsQuery,
    RecentCommentStatItem,
    RegionStatItem
} from '@/contracts/binaryApi';

import { FrameType } from '@wasm/protocol/frame';

import type { ApiRequestConfig } from './requestConfig';

export type { AdminStatsOverview, AdminStatsQuery, RecentCommentStatItem, RegionStatItem, StatsSummary, TrashClearResponse } from '@/contracts/binaryApi';

export const getAdminStatsQuery = (config?: ApiRequestConfig) =>
    requestBinaryOnly<AdminStatsQuery>({
        binaryUrl: '/api/binary/stats',
        privateScope: 'admin',
        frameType: FrameType.AdminStats,
        signal: config?.signal
    });

export const getSiteStatsOverview = async (config?: ApiRequestConfig) =>
    (await getAdminStatsQuery(config)).overview;

export const getRecentCommentStats = (config?: ApiRequestConfig) =>
    requestBinaryOnly<RecentCommentStatItem[]>({
        binaryUrl: '/api/binary/stats/recent-comments',
        privateScope: 'admin',
        frameType: FrameType.RecentCommentStats,
        signal: config?.signal
    });

export const getRegionStats = (config?: ApiRequestConfig) =>
    requestBinaryOnly<RegionStatItem[]>({
        binaryUrl: '/api/binary/stats/regions',
        privateScope: 'admin',
        frameType: FrameType.RegionStats,
        signal: config?.signal
    });
