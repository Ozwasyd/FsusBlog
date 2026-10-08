import { ElMarkdownEditor } from '@ozwasyd/element-plus';

/** A refusal observation, never a preference, default profile, or runtime adapter. */
export type AuthorTypographyMappingAvailability = Readonly<{
    status: 'blocked';
    reason: 'public-typography-contract-unavailable';
    publicEditorDefaultProfile: string | null;
}>;

/**
 * The current public editorProfile contract selects markdown/prose geometry. It does
 * not implement the five independent author typography dimensions. Refuse apply until
 * the UI owner supplies its actual public catalog, font identities and reflow contract.
 * In particular, prop-name discovery alone must never promote a future API to supported.
 */
export function readAuthorTypographyMappingAvailability(): AuthorTypographyMappingAvailability
{
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
