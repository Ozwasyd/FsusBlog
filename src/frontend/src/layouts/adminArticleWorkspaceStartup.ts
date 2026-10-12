import type { ArticleWorkspaceMountedEditorSource } from '@/services/authoring/articleWorkspaceMountedEditorResolver';
import type { AuthoringTabGroupOptions, AuthoringGroupCommandIdentity } from '@/services/authoring/authoringTabGroupRegistry';
import type { AuthoringWorkspaceLayoutPort, AuthoringWorkspacePrimaryMountPort } from '@/services/authoring/authoringWorkspaceLayoutContext';
import type { AuthoringWorkspaceLayoutSource } from '@/services/authoring/authoringWorkspaceLayoutController';
import type { AuthoringWorkspaceSnapshotRestoreCommands } from '@/services/authoring/authoringWorkspaceSnapshotRestore';
import type { AuthoringWorkspaceSnapshotSync } from '@/services/authoring/authoringWorkspaceSnapshotSync';

/** Original-owner capabilities only; no null factory, local batch facts or fabricated receipts. */
export interface AdminArticleWorkspaceStartupPorts {
    readonly sync: AuthoringWorkspaceSnapshotSync;
    readonly resolutionPort: AuthoringWorkspaceSnapshotRestoreCommands['resolutionPort'];
    readonly mountedEditors: ArticleWorkspaceMountedEditorSource;
    /** Pinned actual mounted owner; revoke before callbacks, never cache an auth boolean. */
    readonly beforeMountedAuthorityChange: () => void;
    /** Actual original physical Write operation; a stub cannot satisfy native admission. */
    readonly prepareMountedEditor: AuthoringWorkspacePrimaryMountPort['prepareMountedEditor'];
    readonly groupOptions: Omit<AuthoringTabGroupOptions, 'initialGroupId' | 'initialGroupIds'>;
    readonly createGroupIdentity: () => AuthoringGroupCommandIdentity;
    readonly operationEpoch: number;
    /** The original composition owner cancels this operation and disposes its sync/session resources. */
    readonly signal: AbortSignal;
    readonly assertRuntimeCapability: AuthoringWorkspaceSnapshotRestoreCommands['assertRuntimeCapability'];
    readonly applyShell: AuthoringWorkspaceSnapshotRestoreCommands['applyShell'];
    readonly isCurrent: AuthoringWorkspaceSnapshotRestoreCommands['isCurrent'];
    /** Actual layout authority: real measurements, identities and synchronous before/after notifications. */
    readonly layout?: Omit<AuthoringWorkspaceLayoutSource, 'groups' | 'sessions' | 'mountedEditors' | 'measure'> & {
        measure(projection: Parameters<AuthoringWorkspaceLayoutSource['measure']>[0],
            mountedLayout: AuthoringWorkspaceLayoutPort): ReturnType<AuthoringWorkspaceLayoutSource['measure']>;
    };
}
