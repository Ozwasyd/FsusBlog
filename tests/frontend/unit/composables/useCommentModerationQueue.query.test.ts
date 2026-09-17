import { describe, expect, it } from 'vitest';

import { CommentModerationStatus } from '@/api/authoring';
import {
    applyCommentModerationQuery,
    createCommentModerationQuery,
    type CommentModerationFilters
} from '@/composables/useCommentModerationQueue';

const createFilters = (): CommentModerationFilters => ({
    status: CommentModerationStatus.Pending,
    keyword: '',
    article: '',
    user: '',
    hitReason: '',
    blockedRegion: '',
    modelLabel: '',
    modelProvider: '',
    dateRange: null
});

describe('comment moderation query state', () => {
    it('round-trips primary and advanced filters across refresh and history restoration', () => {
        const filters = createFilters();
        applyCommentModerationQuery(filters, {
            status: '2',
            q: '重复内容',
            article: '42',
            user: 'anonymous-7',
            reason: 'spam-repeat',
            region: 'CN-MAINLAND',
            model: 'risky',
            runtime: 'local',
            from: '2026-07-01',
            to: '2026-07-23'
        });

        expect(createCommentModerationQuery(filters)).toEqual({
            status: '2',
            q: '重复内容',
            article: '42',
            user: 'anonymous-7',
            reason: 'spam-repeat',
            region: 'CN-MAINLAND',
            model: 'risky',
            runtime: 'local',
            from: '2026-07-01',
            to: '2026-07-23'
        });
    });

    it('keeps an incomplete date range out of restored state', () => {
        const filters = createFilters();
        applyCommentModerationQuery(filters, { from: '2026-07-01' });
        expect(filters.dateRange).toBeNull();
        expect(createCommentModerationQuery(filters)).toEqual({});
    });
});
