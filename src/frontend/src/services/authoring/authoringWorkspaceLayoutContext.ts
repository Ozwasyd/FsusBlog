import type { AuthoringTabGroupRegistry } from './authoringTabGroupRegistry';
import type { AuthoringWorkspaceRect } from './authoringWorkspaceGeometryPolicy';
import type { AuthoringWorkspaceLayoutProjection, AuthoringWorkspaceLayoutSource } from './authoringWorkspaceLayoutController';
import type { OpenArticleDocumentRegistry } from './openArticleDocumentRegistry';
import type { InjectionKey, ShallowRef } from 'vue';

/** Borrow the actual mounted layout; these observations issue no readiness or receipt. */
export interface AuthoringWorkspaceLayoutPort {
    refresh(): void;
    invalidate(): void;
    readFrameRect(): AuthoringWorkspaceRect | null;
    readSeparatorRect(): AuthoringWorkspaceRect | null;
}

/** Captured real owners and revisions; this is an observation fence, never a receipt issuer. */
export interface AuthoringWorkspaceOutletExpectation {
    readonly groups: AuthoringTabGroupRegistry;
    readonly registry: OpenArticleDocumentRegistry;
    readonly projection: AuthoringWorkspaceLayoutProjection;
}


/** The original composition root provides its real source; absence remains unavailable. */
export const authoringWorkspaceLayoutSourceKey: InjectionKey<Readonly<ShallowRef<AuthoringWorkspaceLayoutSource | null>>>
    = Symbol('authoring-workspace-layout-source');
