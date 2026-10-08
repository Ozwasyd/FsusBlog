import {
    createArticleEditorSurfacePreference,
    validateArticleEditorSurfacePreference,
    type ArticleEditorSurfacePreference,
    type ArticleEditorSurfaceScope
} from './articleEditorSurface';

export const articleEditorSurfaceMigrationVersion = 1 as const;

export interface ArticleEditorSurfaceMigrationPlan
{
    readonly version: typeof articleEditorSurfaceMigrationVersion;
    readonly preference: ArticleEditorSurfacePreference;
    readonly writeRequired: boolean;
    readonly legacyDisposition: 'remove';
}

/**
 * Explicit, removable upgrade boundary. The persistence owner must atomically write this preference
 * and invalidate its actual legacy field/key; this plan is not a storage-completion receipt.
 * Remove this module once that owner's audited legacy inventory is empty.
 */
export function planArticleEditorSurfaceMigration(
    scope: ArticleEditorSurfaceScope,
    currentPreference: unknown,
    legacyValue: unknown
): ArticleEditorSurfaceMigrationPlan
{
    const current = validateArticleEditorSurfacePreference(currentPreference)
        && currentPreference.siteScope === scope.siteScope && currentPreference.userScope === scope.userScope
        ? currentPreference
        : null;
    // Presence of any new-schema value prevents re-injected history from becoming an authority.
    const surface = currentPreference !== null && currentPreference !== undefined
        ? current?.surface ?? 'live'
        : legacyValue === 'write' || legacyValue === 'source' ? 'source' : 'live';
    return Object.freeze({
        version: articleEditorSurfaceMigrationVersion,
        preference: createArticleEditorSurfacePreference(scope, surface),
        writeRequired: current === null,
        legacyDisposition: 'remove'
    });
}
