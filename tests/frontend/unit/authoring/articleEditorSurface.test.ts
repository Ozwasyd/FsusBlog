import { describe, expect, it } from 'vitest';

import {
    articleEditorSurfaces,
    createArticleEditorSurfacePreference,
    isArticleEditorSurface,
    readArticleEditorSurfacePreference,
    validateArticleEditorSurfacePreference
} from '@/services/authoring/articleEditorSurface';

const scope = { siteScope: 'site:test', userScope: 'user:test' };

describe('article product surface preference (#2280)', () => {
    it('has exactly two product surfaces and defaults to live', () => {
        expect(articleEditorSurfaces).toEqual(['live', 'source']);
        expect(createArticleEditorSurfacePreference(scope).surface).toBe('live');
        expect(Object.isFrozen(createArticleEditorSurfacePreference(scope))).toBe(true);
    });

    it.each(['live', 'source'] as const)('preserves explicit %s across a serialized reload', surface => {
        const value = createArticleEditorSurfacePreference(scope, surface);
        expect(readArticleEditorSurfacePreference(JSON.parse(JSON.stringify(value)), scope)).toEqual(value);
    });

    it.each(['write', 'preview', 'split', 'unknown', '', null, 0, {}, []])('rejects normal-path input %j', surface => {
        expect(isArticleEditorSurface(surface)).toBe(false);
        const value = { ...createArticleEditorSurfacePreference(scope), surface };
        expect(validateArticleEditorSurfacePreference(value)).toBe(false);
        expect(readArticleEditorSurfacePreference(value, scope).surface).toBe('live');
    });

    it.each(['siteScope', 'userScope'] as const)('isolates %s and never uses another owner preference', field => {
        const value = createArticleEditorSurfacePreference(scope, 'source');
        expect(readArticleEditorSurfacePreference(value, { ...scope, [field]: 'other:scope' }).surface).toBe('live');
    });

    it.each(['sourceCompareOpen', 'publishPreviewOpen', 'selection', 'documentEpoch', 'writingAids', 'mode'])('rejects extra %s even with an otherwise valid preference', field => {
        const value = { ...createArticleEditorSurfacePreference(scope, 'source'), [field]: true };
        expect(validateArticleEditorSurfacePreference(value)).toBe(false);
    });

    it('refuses future schemas, altered surface digests and malformed scopes', () => {
        const value = createArticleEditorSurfacePreference(scope, 'source');
        expect(validateArticleEditorSurfacePreference({ ...value, schema: `${value.schema}.future` })).toBe(false);
        expect(validateArticleEditorSurfacePreference({ ...value, surface: 'live' })).toBe(false);
        expect(() => createArticleEditorSurfacePreference({ ...scope, userScope: '' })).toThrow();
    });
});
