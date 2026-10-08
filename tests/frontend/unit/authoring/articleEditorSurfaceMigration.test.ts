import { describe, expect, it } from 'vitest';

import { createArticleEditorSurfacePreference, readArticleEditorSurfacePreference } from '@/services/authoring/articleEditorSurface';
import { planArticleEditorSurfaceMigration } from '@/services/authoring/articleEditorSurfaceMigration';

const scope = { siteScope: 'site:test', userScope: 'user:test' };

describe('explicit removable surface migration boundary (#2280)', () => {
    it.each([
        ['write', 'source'], ['source', 'source'], ['live', 'live'], ['preview', 'live'], ['split', 'live'],
        ['unknown', 'live'], [null, 'live'], [{ mode: 'write' }, 'live'], [4, 'live']
    ])('plans legacy %j as %s', (legacy, expected) => {
        const plan = planArticleEditorSurfaceMigration(scope, null, legacy);
        expect(plan.preference.surface).toBe(expected);
        expect(plan.writeRequired).toBe(true);
        expect(plan.legacyDisposition).toBe('remove');
    });

    it('is idempotent after host write and ignores re-injected historical values', () => {
        const first = planArticleEditorSurfaceMigration(scope, undefined, 'write');
        const repeated = planArticleEditorSurfaceMigration(scope, first.preference, 'split');
        expect(repeated.preference).toEqual(first.preference);
        expect(repeated.writeRequired).toBe(false);
        expect(planArticleEditorSurfaceMigration(scope, createArticleEditorSurfacePreference(scope), 'write').preference.surface).toBe('live');
    });

    it('does not reinterpret corrupt or future new-schema values through legacy history', () => {
        for (const value of [{}, { schema: 'future', surface: 'source' }, 'source']) {
            expect(planArticleEditorSurfaceMigration(scope, value, 'write').preference.surface).toBe('live');
        }
    });

    it('does not move a preference across user/site scope or broaden normal readers', () => {
        const current = createArticleEditorSurfacePreference({ ...scope, userScope: 'user:other' }, 'source');
        expect(planArticleEditorSurfaceMigration(scope, current, 'write').preference.surface).toBe('live');
        expect(readArticleEditorSurfacePreference('write', scope).surface).toBe('live');
    });
});
