import type { ArticleNativeRecreationSource, ArticleNativeRecreationStagingLease } from './articleNativeRecreationStaging';
import type { AuthoringTabGroupRegistry } from './authoringTabGroupRegistry';
import type { AuthoringWorkspaceRect } from './authoringWorkspaceGeometryPolicy';
import type { AuthoringWorkspaceLayoutProjection, AuthoringWorkspaceLayoutSource } from './authoringWorkspaceLayoutController';
import type { OpenArticleDocumentEntry, OpenArticleDocumentRegistry } from './openArticleDocumentRegistry';
import type { InjectionKey, Ref, ShallowRef } from 'vue';

/** Borrow the actual mounted layout; these observations issue no readiness or receipt. */
export interface AuthoringWorkspaceLayoutPort {
    refresh(): void;
    invalidate(): void;
    readFrameRect(): AuthoringWorkspaceRect | null;
    readSeparatorRect(): AuthoringWorkspaceRect | null;
}

/** Physical completion for the existing primary Write mount; no host/resource admission. */
export interface AuthoringWorkspacePrimaryMountPort {
    prepareMountedEditor(entry: Readonly<OpenArticleDocumentEntry>, signal: AbortSignal): Promise<void>;
    /** Actual physical staging before Main native adoption; never an ordinary mounted seal. */
    reserveNativeRecreationTarget(entry: Readonly<OpenArticleDocumentEntry>, source: ArticleNativeRecreationSource,
        signal: AbortSignal): Promise<ArticleNativeRecreationStagingLease>;
    /** Retry the same Root-owned staging debt even if no lease was transferred. */
    retryNativeRecreationCleanup(): void;
    sealMountedAuthority(editorSessionRef: string): AuthoringWorkspaceRootMountedSeal | null;
    hasMountedAuthorityCustody(seal: AuthoringWorkspaceRootMountedSeal): boolean;
    cancelMountedAuthority(seal: AuthoringWorkspaceRootMountedSeal): boolean;
    /** Root must invoke this BEFORE route-outlet/retained identity/startup retirement changes. */
    revokeBeforeChange(): void;
    /** Revoke outstanding custody BEFORE any external resolver/native/source callback. */
    revokeBeforeExternalRead(): void;
    /** Original Root calls BEFORE its same sessions.retire()/startup cancellation callbacks. */
    retireMountedAuthority(): void;
}

declare const rootMountedSealBrand: unique symbol;
export interface AuthoringWorkspaceRootMountedSeal {
    readonly [rootMountedSealBrand]: true;
    readonly scope: 'root-mounted';
}

/** Required original producer join, not an auth/membership assertion or a boolean snapshot. */
export interface AuthoringWorkspaceMountedAuthorityReservation {
    readonly nativeEditor: object;
    readonly retainedIdentity: object;
    /** Pure original private token joins; not reactive reads, cell.read() or listener caches. */
    hasCustody(): boolean;
    /** Cancel reservations only; do not release the actual document/native owner. */
    cancel(): void;
}
export interface AuthoringWorkspaceMountedAuthoritySources {
    /**
     * Root must reserve the ORIGINAL membership/document/Writer/principal tokens,
     * and connect revoke at their private pre-mutation boundary BEFORE callbacks.
     * Missing tokens or pre-revocation support must return null.
     */
    reserve(editorSessionRef: string, originalMountedRuntime: object, nativeEditor: object,
        revokeBeforeChange: () => void): AuthoringWorkspaceMountedAuthorityReservation | null;
}
/** No default authority source. Root provides its actual original producer join or null. */
export const authoringWorkspaceMountedAuthoritySourcesKey: InjectionKey<Readonly<ShallowRef<AuthoringWorkspaceMountedAuthoritySources | null>>>
    = Symbol('authoring-workspace-mounted-authority-sources');
export const authoringWorkspaceMountedAuthorityBeforeReadKey: InjectionKey<() => void>
    = Symbol('authoring-workspace-mounted-authority-before-read');

/** Actual Root startup phase suppresses route registration while preserving the physical subtree. */
export const authoringWorkspacePrimaryMountOnlyKey: InjectionKey<Readonly<Ref<boolean>>>
    = Symbol('authoring-workspace-primary-mount-only');

/** Captured real owners and revisions; this is an observation fence, never a receipt issuer. */
export interface AuthoringWorkspaceOutletExpectation {
    readonly groups: AuthoringTabGroupRegistry;
    readonly registry: OpenArticleDocumentRegistry;
    readonly projection: AuthoringWorkspaceLayoutProjection;
}


/** The original composition root provides its real source; absence remains unavailable. */
export const authoringWorkspaceLayoutSourceKey: InjectionKey<Readonly<ShallowRef<AuthoringWorkspaceLayoutSource | null>>>
    = Symbol('authoring-workspace-layout-source');
