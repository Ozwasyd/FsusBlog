import { FsusUiMarkdownEditor as ElMarkdownEditor } from '@/fsusui/markdownEditor';
import { AUTHOR_TYPOGRAPHY_CHOICES, AUTHOR_TYPOGRAPHY_FIELDS, isAuthorTypographyProfileView } from '@/view-contracts/authorTypographyProfile';
import type { AuthorTypographyDimension } from '@/view-contracts/authorTypographyProfile';

import type { ArticleEditorRuntimeBinding } from './articleEditorRuntimeBinding';

export interface AuthorTypographyDimensionMapping
{
    readonly dimension: AuthorTypographyDimension;
    readonly values: readonly string[];
    readonly inspectedPublicContracts: readonly string[];
    readonly target: null;
    readonly status: 'blocked';
    readonly missingContract: string;
}

/** Audited names only, no copied token values or inferred author-editor override. */
export function readAuthorTypographyDimensionMappings(): readonly AuthorTypographyDimensionMapping[]
{
    const inspected: Record<AuthorTypographyDimension, readonly string[]> = {
        fontFamily: ['--fsus-typography-family-body', '--fsus-typography-family-monospace'],
        fontSize: ['--fsus-typography-body-md-size', '--fsus-typography-body-lg-size'],
        lineHeight: ['--fsus-typography-body-md-line-height'],
        canvasWidth: ['ElMarkdownEditor.props.editorProfile'],
        paragraphSpacing: ['--fsus-space-2', '--fsus-space-4', '--fsus-space-6']
    };
    const missing: Record<AuthorTypographyDimension, string> = {
        fontFamily: 'Registered system-sans/reading-serif/cjk-sans author profiles with pinned no-network fallback; body/monospace stacks do not supply them.',
        fontSize: 'Closed compact/standard/large author-editor size contract; body tokens do not control prose editor text size.',
        lineHeight: 'Closed compact/standard/relaxed author-editor line-height contract; one body line-height token is insufficient.',
        canvasWidth: 'Closed narrow/standard/wide author-editor width contract; markdown/prose editorProfile cannot independently select width.',
        paragraphSpacing: 'Closed compact/standard/relaxed author paragraph rhythm contract; task spacing tokens do not specify prose paragraph margins.'
    };
    return Object.freeze(AUTHOR_TYPOGRAPHY_FIELDS.map(dimension => Object.freeze({
        dimension, values: AUTHOR_TYPOGRAPHY_CHOICES[dimension],
        inspectedPublicContracts: Object.freeze(inspected[dimension]),
        target: null, status: 'blocked' as const, missingContract: missing[dimension]
    })));
}

/** A refusal observation, never a preference, default profile, or runtime adapter. */
export type AuthorTypographyMappingAvailability = Readonly<{
    status: 'blocked';
    reason: 'invalid-profile' | 'public-typography-contract-unavailable';
    publicEditorDefaultProfile: string | null;
}>;

/**
 * The current public editorProfile contract selects markdown/prose geometry. It does
 * not implement the five independent author typography dimensions. Refuse apply until
 * the UI owner supplies its actual public catalog, font identities and reflow contract.
 * In particular, prop-name discovery alone must never promote a future API to supported.
 */
export function readAuthorTypographyMappingAvailability(
    ...profiles: [] | [profile: unknown]
): AuthorTypographyMappingAvailability
{
    // Keep the original argument-free capability probe. Supplied profiles must pass
    // the existing closed preflight before inspecting any upstream capability/default.
    if (profiles.length === 1 && !isAuthorTypographyProfileView(profiles[0]))
    {
        return Object.freeze({
            status: 'blocked', reason: 'invalid-profile', publicEditorDefaultProfile: null
        });
    }
    // The public package and local source are checked independently. Inspect the exported
    // public prop defensively; a missing package declaration must not manufacture a default.
    const editor: unknown = ElMarkdownEditor;
    const props = isRecord(editor) ? editor.props : null;
    const profile = isRecord(props) ? props.editorProfile : null;
    const defaultProfile = isRecord(profile) ? profile.default : null;
    return Object.freeze({
        status: 'blocked',
        reason: 'public-typography-contract-unavailable',
        publicEditorDefaultProfile: typeof defaultProfile === 'string' ? defaultProfile : null
    });
}

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Capture through the existing Writer binding before a future supported typography
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
