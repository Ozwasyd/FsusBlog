import { calculateOpenArticleDocumentDigest as digest } from './openArticleDocumentRegistry';

export const articleEditorSurfaces = ['live', 'source'] as const;
export type ArticleEditorSurface = typeof articleEditorSurfaces[number];
export const defaultArticleEditorSurface: ArticleEditorSurface = 'live';
export const articleEditorSurfacePreferenceSchema = 'fsusblog.article-editor-surface-preference.v1' as const;

export interface ArticleEditorSurfaceScope
{
    readonly siteScope: string;
    readonly userScope: string;
}

/** User/site preference only. Document, tool, capability and writing-aid state have other owners. */
export interface ArticleEditorSurfacePreference extends ArticleEditorSurfaceScope
{
    readonly schema: typeof articleEditorSurfacePreferenceSchema;
    readonly surface: ArticleEditorSurface;
    readonly contentDigest: string;
}

export function isArticleEditorSurface(value: unknown): value is ArticleEditorSurface
{
    return value === 'live' || value === 'source';
}

export function createArticleEditorSurfacePreference(
    scope: ArticleEditorSurfaceScope,
    surface: ArticleEditorSurface = defaultArticleEditorSurface
): ArticleEditorSurfacePreference
{
    if (!isArticleEditorSurface(surface)
        || ![scope.siteScope, scope.userScope].every(value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{2,127}$/u.test(value)))
    {
        throw new Error('article-editor-surface-preference-invalid');
    }
    const value = {
        schema: articleEditorSurfacePreferenceSchema,
        siteScope: scope.siteScope,
        userScope: scope.userScope,
        surface
    };
    return Object.freeze({ ...value, contentDigest: digest(value) });
}

export function validateArticleEditorSurfacePreference(value: unknown): value is ArticleEditorSurfacePreference
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    const record = value as Record<string, unknown>;
    const keys = ['schema', 'siteScope', 'userScope', 'surface', 'contentDigest'];
    if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key))
        || record.schema !== articleEditorSurfacePreferenceSchema || !isArticleEditorSurface(record.surface)
        || typeof record.siteScope !== 'string' || typeof record.userScope !== 'string')
    {
        return false;
    }
    try
    {
        return createArticleEditorSurfacePreference({ siteScope: record.siteScope, userScope: record.userScope }, record.surface).contentDigest === record.contentDigest;
    }
    catch
    {
        return false;
    }
}

/** Normal readers reject every historical or corrupt value; they never invoke the migration boundary. */
export function readArticleEditorSurfacePreference(value: unknown, scope: ArticleEditorSurfaceScope): ArticleEditorSurfacePreference
{
    return validateArticleEditorSurfacePreference(value) && value.siteScope === scope.siteScope && value.userScope === scope.userScope
        ? createArticleEditorSurfacePreference(scope, value.surface)
        : createArticleEditorSurfacePreference(scope);
}
