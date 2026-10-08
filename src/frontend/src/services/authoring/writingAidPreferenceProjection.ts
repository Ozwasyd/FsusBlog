import type {
    WritingAidPreferenceOwner,
    WritingAidPreferenceSnapshot
} from '@/contracts/binaryApi';

import { bindWritingAidPreferenceSnapshot } from './writingAidPreferenceReceiptBinding';

import type { MarkdownEditorResolvedWritingAids } from '@ozwasyd/element-plus';

export interface WritingAidPreferenceProjection {
    readonly editorWritingAids: Readonly<Pick<MarkdownEditorResolvedWritingAids, 'focus' | 'typewriter'>> | null;
    readonly immersiveEnabled: boolean | null;
}

/**
 * Project a current account-owner snapshot into public requests. The existing
 * runtime policy decides effective behavior; the shell consumes Immersive
 * independently. Missing authority stays unavailable, never a persisted default.
 */
export function projectWritingAidPreference(
    snapshot: WritingAidPreferenceSnapshot | null,
    owner: WritingAidPreferenceOwner
): WritingAidPreferenceProjection
{
    if (snapshot === null)
    {
        return Object.freeze({ editorWritingAids: null, immersiveEnabled: null });
    }
    const current = bindWritingAidPreferenceSnapshot(snapshot, owner);
    return Object.freeze({
        editorWritingAids: Object.freeze({
            focus: current.values.focusEnabled,
            typewriter: current.values.typewriterEnabled
        }),
        immersiveEnabled: current.values.immersiveEnabled
    });
}
