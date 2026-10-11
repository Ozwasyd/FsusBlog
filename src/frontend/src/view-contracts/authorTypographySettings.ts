import { readAuthorTypographyMappingAvailability } from '@/services/authoring/authorTypographyMapping';

import { isAuthorTypographyProfileView } from './authorTypographyProfile';

import type { AuthorTypographyProfileView } from './authorTypographyProfile';

/** A controlled display projection supplied by the integrating owner, never an auth proof or preference store. */
export interface AuthorTypographySettingsView
{
    readonly profile: AuthorTypographyProfileView | null;
    readonly revision: number | null;
    readonly status: 'loading' | 'current' | 'saving' | 'saved' | 'conflict' | 'unavailable';
    readonly permission: 'allowed' | 'denied' | 'unavailable';
    readonly device: 'verified' | 'unavailable';
    readonly designDefault: 'verified' | 'unavailable';
    readonly font: 'unavailable' | 'loading' | 'loaded' | 'failed' | 'fallback';
}

export type AuthorTypographySettingsBlock = 'permission' | 'device' | 'default' | 'observation'
    | 'exhausted' | 'pending' | 'conflict' | 'unavailable' | 'mapping';

/** Client UX guard only. The server must still verify access/device/default and execute the sole CAS. */
export function authorTypographySettingsBlock(view: AuthorTypographySettingsView): AuthorTypographySettingsBlock | null
{
    if (view.permission !== 'allowed')
    {
        return 'permission';
    }
    if (view.device !== 'verified')
    {
        return 'device';
    }
    if (view.designDefault !== 'verified')
    {
        return 'default';
    }
    if (!isAuthorTypographyProfileView(view.profile) || !Number.isSafeInteger(view.revision)
        || view.revision === null || view.revision < 0)
    {
        return 'observation';
    }
    if (view.revision === Number.MAX_SAFE_INTEGER)
    {
        return 'exhausted';
    }
    if (view.status === 'loading' || view.status === 'saving')
    {
        return 'pending';
    }
    if (view.status === 'conflict')
    {
        return 'conflict';
    }
    if (view.status === 'unavailable')
    {
        return 'unavailable';
    }
    // The actual aliased public contract must support all dimensions; display flags cannot invent that capability.
    if (readAuthorTypographyMappingAvailability(view.profile).status === 'blocked')
    {
        return 'mapping';
    }
    return null;
}
