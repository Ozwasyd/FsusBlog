import type { AuthoringWorkspaceRect } from './authoringWorkspaceGeometryPolicy';
import type { AuthoringWorkspaceLayoutSource } from './authoringWorkspaceLayoutController';
import type { InjectionKey, ShallowRef } from 'vue';

/** Borrow the actual mounted layout; these observations issue no readiness or receipt. */
export interface AuthoringWorkspaceLayoutPort {
    refresh(): void;
    invalidate(): void;
    readFrameRect(): AuthoringWorkspaceRect | null;
    readSeparatorRect(): AuthoringWorkspaceRect | null;
}


/** The original composition root provides its real source; absence remains unavailable. */
export const authoringWorkspaceLayoutSourceKey: InjectionKey<Readonly<ShallowRef<AuthoringWorkspaceLayoutSource | null>>>
    = Symbol('authoring-workspace-layout-source');
