import { FsusUiMarkdownEditor, MARKDOWN_EDITOR_TYPOGRAPHY_CATALOG, resolveMarkdownEditorTypography } from '@/fsusui/markdownEditor';
import type { MarkdownEditorTypographyRequest, MarkdownEditorTypographyResult } from '@/fsusui/markdownEditor';
import { AUTHOR_TYPOGRAPHY_FIELDS } from '@/view-contracts/authorTypographyProfile';
import type { AuthorTypographyDimension } from '@/view-contracts/authorTypographyProfile';

import type { ArticleEditorRuntimeBinding } from './articleEditorRuntimeBinding';

export interface AuthorTypographyDimensionMapping
{
    readonly dimension: AuthorTypographyDimension;
    readonly values: readonly string[];
    readonly supportedValues: readonly string[];
    readonly publicCatalog: typeof MARKDOWN_EDITOR_TYPOGRAPHY_CATALOG;
    readonly target: Readonly<Record<string, string>> | string;
    readonly status: 'supported' | 'partial';
    readonly unsupportedReason: string | null;
}

/** Project the actual public catalog by reference; numeric/style authority remains in FsusUI. */
export function readAuthorTypographyDimensionMappings(): readonly AuthorTypographyDimensionMapping[]
{
    const catalog = MARKDOWN_EDITOR_TYPOGRAPHY_CATALOG;
    return Object.freeze(AUTHOR_TYPOGRAPHY_FIELDS.map(dimension => Object.freeze({
        dimension, values: catalog.choices[dimension], supportedValues: catalog.supported[dimension],
        publicCatalog: catalog,
        target: dimension === 'paragraphSpacing' ? catalog.baseline.paragraphSpacing : catalog.mapping[dimension],
        status: catalog.supported[dimension].length === catalog.choices[dimension].length ? 'supported' as const : 'partial' as const,
        unsupportedReason: dimension === 'fontFamily' || dimension === 'paragraphSpacing' ? catalog.mapping.unsupported[dimension] : null
    })));
}

/** Capability only; supported never means visually applied, persisted, or accepted. */
export type AuthorTypographyMappingAvailability = Readonly<{
    publicEditorDefaultProfile: string | null;
} & ({ status: 'supported'; reason: null; } | {
    status: 'blocked'; reason: 'invalid-profile' | 'profile-required' | 'unsupported-profile';
})>;

/**
 * Resolve through the public upstream implementation. An argument-free probe does not
 * invent an author preference/default; editorProfile remains a separate presentation prop.
 */
export function readAuthorTypographyMappingAvailability(
    ...profiles: [] | [profile: unknown]
): AuthorTypographyMappingAvailability
{
    const resolution = profiles.length === 1 ? resolveMarkdownEditorTypography(profiles[0]) : null;
    if (resolution?.status === 'invalid')
    {
        return Object.freeze({
            status: 'blocked', reason: 'invalid-profile', publicEditorDefaultProfile: null
        });
    }
    const editor: unknown = FsusUiMarkdownEditor;
    const props = isRecord(editor) ? editor.props : null;
    const presentation = isRecord(props) ? props.editorProfile : null;
    const defaultProfile: unknown = isRecord(presentation) ? presentation.default : null;
    const publicEditorDefaultProfile = typeof defaultProfile === 'string' ? defaultProfile : null;
    if (resolution?.status === 'supported')
    {
        return Object.freeze({ status: 'supported', reason: null, publicEditorDefaultProfile });
    }
    return Object.freeze({
        status: 'blocked',
        reason: resolution === null ? 'profile-required' : 'unsupported-profile',
        publicEditorDefaultProfile
    });
}

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow the documented exposed method using its public request/result types; Writer supplies the mounted instance. */
export interface AuthorTypographyEditorPort
{
    applyTypography(request: MarkdownEditorTypographyRequest): Promise<MarkdownEditorTypographyResult>;
}

/**
 * Preserve the exact public Promise/result. The UI owns request validation, font/layout
 * scheduling and restoration. This does not save preferences or complete Writer continuity.
 */
export function applyAuthorTypographyToEditor(
    editor: AuthorTypographyEditorPort,
    request: MarkdownEditorTypographyRequest
): Promise<MarkdownEditorTypographyResult>
{
    return editor.applyTypography(request);
}

/**
 * Capture through the existing Writer binding before typography
 * reflow. The canonical owner validates document/revision, public selection/history,
 * surface/tool and lifetime. Return its sealed context directly: no parallel anchor,
 * document state, receipt or persistence is created, and capture does not apply a profile.
 */
export function captureAuthorTypographyContinuity(
    binding: ArticleEditorRuntimeBinding,
    options: Parameters<ArticleEditorRuntimeBinding['continuity']['capture']>[1]
): ReturnType<ArticleEditorRuntimeBinding['continuity']['capture']>
{
    return binding.continuity.capture(binding.positionBinding(), options);
}
