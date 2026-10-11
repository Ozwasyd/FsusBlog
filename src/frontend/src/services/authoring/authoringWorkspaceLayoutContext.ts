import type { AuthoringWorkspaceLayoutSource } from './authoringWorkspaceLayoutController';
import type { InjectionKey, ShallowRef } from 'vue';


/** The original composition root provides its real source; absence remains unavailable. */
export const authoringWorkspaceLayoutSourceKey: InjectionKey<Readonly<ShallowRef<AuthoringWorkspaceLayoutSource | null>>>
    = Symbol('authoring-workspace-layout-source');
